import {
  DEFAULT_SETTINGS,
  type ConfirmActionResponseMessage,
  type DomScanResultMessage,
  type LastScanResponse,
  type LlmChatRequestMessage,
  type LlmChatResponse,
  type ProviderChoice,
  type RunAgentTaskFromPanelMessage,
  type StartAgentTaskMessage,
  type VeilBrowseMessage,
  type VeilBrowseSettings,
} from '@veilbrowse/shared-types';

/**
 * VeilBrowse background service worker.
 *
 * - Owns the task session for each tab, so a task continues across page navigations.
 * - Injects the content script on demand, only on sites the user has allowed.
 * - Calls the local Ollama server (content scripts run with the page's origin).
 * - Takes screenshots for visual perception, blacks out sensitive regions, and sends
 *   them to a LOCAL vision model.
 * - Relays the user's confirmations and Stop from the side panel to the tab.
 *
 * PRIVACY: logs counts only; never labels, values or page text.
 */

const STORAGE_KEY = 'veilbrowse_last_scan';
const SESSIONS_KEY = 'veilbrowse_sessions';
const SETTINGS_KEY = 'veilbrowse.settings';
const OLLAMA_ENDPOINT = 'http://127.0.0.1:11434';
const MODEL_NAME = /^[a-z0-9._:/-]{1,80}$/i;
const MAX_STEPS = 15;

interface Session {
  task: string;
  provider: ProviderChoice;
  visual: boolean;
  history: unknown[];
  piiMasked: number;
  state: 'running' | 'navigating' | 'awaiting-access';
  updatedAt: number;
}

// ---------------------------------------------------------------- sessions

const sessions = new Map<number, Session>();
let sessionsLoaded = false;

async function loadSessions(): Promise<void> {
  if (sessionsLoaded) return;
  sessionsLoaded = true;
  try {
    const stored = (await chrome.storage.session.get(SESSIONS_KEY))[SESSIONS_KEY] as Record<string, Session> | undefined;
    for (const [k, v] of Object.entries(stored ?? {})) if (!sessions.has(Number(k))) sessions.set(Number(k), v);
  } catch {
    /* ignore */
  }
}

async function saveSessions(): Promise<void> {
  const obj: Record<string, Session> = {};
  for (const [k, v] of sessions) obj[String(k)] = v;
  await chrome.storage.session.set({ [SESSIONS_KEY]: obj }).catch(() => undefined);
}

async function getSettings(): Promise<VeilBrowseSettings> {
  try {
    const s = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] as Partial<VeilBrowseSettings> | undefined;
    return {
      textModel: s?.textModel && MODEL_NAME.test(s.textModel) ? s.textModel : DEFAULT_SETTINGS.textModel,
      visionModel: s?.visionModel && MODEL_NAME.test(s.visionModel) ? s.visionModel : DEFAULT_SETTINGS.visionModel,
      timeoutSec: typeof s?.timeoutSec === 'number' && s.timeoutSec >= 30 && s.timeoutSec <= 3600 ? s.timeoutSec : DEFAULT_SETTINGS.timeoutSec,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function toPanel(message: Record<string, unknown>): void {
  chrome.runtime.sendMessage(message).catch(() => undefined);
}

function originPattern(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

/** Make sure the content script is running in the tab; inject it on demand if not. */
async function pingContent(tabId: number): Promise<{ ok?: boolean; running?: boolean } | undefined> {
  try {
    return (await chrome.tabs.sendMessage(tabId, { type: 'PING_CONTENT' })) as { ok?: boolean; running?: boolean };
  } catch {
    return undefined;
  }
}

async function ensureContentScript(tabId: number): Promise<void> {
  if ((await pingContent(tabId))?.ok) return;
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
}

/** Start or resume the session's loop in the tab's current page. */
async function runSessionOnTab(tabId: number): Promise<{ ok: boolean; error?: string }> {
  const session = sessions.get(tabId);
  if (!session) return { ok: false, error: 'No task to run.' };
  const tab = await chrome.tabs.get(tabId);
  const pattern = originPattern(tab.url ?? '');
  if (!pattern) {
    sessions.delete(tabId);
    await saveSessions();
    return { ok: false, error: 'VeilBrowse can only run on regular web pages (http or https).' };
  }
  if (!(await chrome.permissions.contains({ origins: [pattern] }))) {
    session.state = 'awaiting-access';
    await saveSessions();
    toPanel({ type: 'NEED_SITE_ACCESS', tabId, pattern, host: new URL(tab.url as string).hostname });
    return { ok: true };
  }
  try {
    await ensureContentScript(tabId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Could not access this page. (${detail})` };
  }
  const settings = await getSettings();
  session.state = 'running';
  session.updatedAt = Date.now();
  await saveSessions();
  const start: StartAgentTaskMessage = {
    type: 'START_AGENT_TASK',
    payload: {
      task: session.task,
      provider: session.provider,
      visual: session.visual,
      textModel: settings.textModel,
      visionModel: settings.visionModel,
      history: session.history,
      piiMasked: session.piiMasked,
      maxSteps: MAX_STEPS,
    },
  };
  const response = (await chrome.tabs.sendMessage(tabId, start)) as { ok: boolean; error?: string } | undefined;
  return response ?? { ok: true };
}

// Continue the task after the page navigates.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  void (async () => {
    await loadSessions();
    const session = sessions.get(tabId);
    if (!session) return;
    if (info.status === 'loading') {
      session.state = 'navigating';
      await saveSessions();
      toPanel({ type: 'AGENT_STATUS_UPDATE', status: 'NAVIGATING', currentStep: 'Opening the next page' });
      return;
    }
    if (info.status === 'complete' && session.state === 'navigating') {
      // Same-document navigations keep the old script running; don't start a second loop.
      if ((await pingContent(tabId))?.running) {
        session.state = 'running';
        await saveSessions();
        return;
      }
      const r = await runSessionOnTab(tabId);
      if (!r.ok) {
        sessions.delete(tabId);
        await saveSessions();
        toPanel({ type: 'AGENT_TASK_COMPLETED', payload: { status: 'ERROR', finalResult: r.error, steps: session.history } });
      }
    }
  })();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (sessions.delete(tabId)) void saveSessions();
});

// ---------------------------------------------------------------- Ollama

async function ollamaChat(body: Record<string, unknown>, timeoutMs: number): Promise<LlmChatResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${OLLAMA_ENDPOINT}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stream: false, ...body }),
      signal: controller.signal,
    });
    if (res.status === 403) {
      return { ok: false, error: 'Ollama refused the request. Start Ollama with OLLAMA_ORIGINS=chrome-extension://* (see README).' };
    }
    if (res.status === 404) return { ok: false, error: `Model "${String(body.model)}" is not installed. Run: ollama pull ${String(body.model)}` };
    if (!res.ok) return { ok: false, error: `Ollama HTTP ${res.status}` };
    const data = (await res.json()) as { message?: { content?: string } };
    const content = data.message?.content?.trim();
    return content ? { ok: true, content } : { ok: false, error: 'Empty response from the model' };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return { ok: false, error: aborted ? 'The local model timed out. On a slow computer, raise "Model time limit" in Settings or close other apps to free memory.' : 'Could not reach Ollama at 127.0.0.1:11434. Is it running?' };
  } finally {
    clearTimeout(timer);
  }
}

async function proxyLlmChat(message: LlmChatRequestMessage): Promise<LlmChatResponse> {
  const { model, messages, format } = message.payload;
  if (typeof model !== 'string' || !MODEL_NAME.test(model) || !Array.isArray(messages)) {
    return { ok: false, error: 'Invalid model request' };
  }
  const schema = format && typeof format === 'object' && JSON.stringify(format).length < 4000 ? format : 'json';
  // Short JSON answers; keep the model loaded between steps. CPU-only machines can take minutes per call.
  const { timeoutSec } = await getSettings();
  return ollamaChat({ model, messages, format: schema, keep_alive: '30m', options: { temperature: 0.1, num_predict: 200, num_ctx: 4096 } }, timeoutSec * 1000);
}

// ---------------------------------------------------------------- visual perception

interface Rect { x: number; y: number; width: number; height: number }
interface VisualRequest {
  task: string;
  masks: Rect[];
  marks: Array<{ n: number; rect: Rect }>;
  viewport: { width: number; height: number };
  model: string;
}

const VISION_PROMPT = (task: string) =>
  `This is a screenshot of a web page. Black boxes hide private information; ignore them. ` +
  `Red numbered boxes mark clickable or typeable controls.\n` +
  `The user wants to: "${task}".\n` +
  `In at most 8 short lines: say what kind of page this is, its main sections, and which numbered boxes ` +
  `(write them as [n]) are relevant to the task and what they do. Describe anything important that is only ` +
  `visible as an image. Do not write out names, emails, phone numbers, addresses or account/card numbers.`;

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Screenshot -> black out sensitive regions -> draw numbered marks -> local vision model. */
async function visualPerception(req: VisualRequest, windowId: number): Promise<LlmChatResponse> {
  if (!MODEL_NAME.test(req.model)) return { ok: false, error: 'Invalid vision model name' };
  let dataUrl: string;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  } catch (err) {
    return { ok: false, error: `Screenshot failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const outW = Math.min(bitmap.width, 768); // fewer image tokens: much faster on CPU
  const k = outW / bitmap.width;
  const canvas = new OffscreenCanvas(outW, Math.round(bitmap.height * k));
  const ctx = canvas.getContext('2d');
  if (!ctx) return { ok: false, error: 'Canvas unavailable' };
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  // CSS pixels -> output pixels.
  const f = (bitmap.width / Math.max(1, req.viewport.width)) * k;
  ctx.fillStyle = '#000';
  for (const m of req.masks) ctx.fillRect(m.x * f, m.y * f, m.width * f, m.height * f);

  ctx.lineWidth = 2;
  ctx.font = 'bold 13px sans-serif';
  for (const { n, rect } of req.marks) {
    ctx.strokeStyle = '#e11d48';
    ctx.strokeRect(rect.x * f, rect.y * f, rect.width * f, rect.height * f);
    const label = String(n);
    const w = ctx.measureText(label).width + 6;
    ctx.fillStyle = '#e11d48';
    ctx.fillRect(rect.x * f, rect.y * f - 16, w, 16);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, rect.x * f + 3, rect.y * f - 3);
  }
  // Masks are drawn again on top, so no mark label can uncover a hidden region.
  ctx.fillStyle = '#000';
  for (const m of req.masks) ctx.fillRect(m.x * f, m.y * f, m.width * f, m.height * f);

  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  const image = toBase64(await blob.arrayBuffer());
  return ollamaChat(
    { model: req.model, messages: [{ role: 'user', content: VISION_PROMPT(req.task), images: [image] }], keep_alive: '30m', options: { temperature: 0.1, num_predict: 300 } },
    (await getSettings()).timeoutSec * 1000
  );
}

// ---------------------------------------------------------------- messages

chrome.runtime.onMessage.addListener(
  (message: VeilBrowseMessage, sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void): boolean | undefined => {
    // Only this extension's own pages and content scripts.
    if (sender.id !== chrome.runtime.id) return undefined;
    // Extension pages (side panel, popup) vs content scripts running inside web pages.
    // Content scripts always carry sender.tab; the real side panel may report no URL, so also accept
    // senders without a tab (a web page can never send runtime messages to this extension).
    const extOrigin = chrome.runtime.getURL('');
    const fromExtensionPage =
      (typeof sender.url === 'string' && sender.url.startsWith(extOrigin)) ||
      (typeof sender.origin === 'string' && extOrigin.startsWith(sender.origin)) ||
      !sender.tab;
    const senderTab = sender.tab?.id;
    const m = message as unknown as Record<string, unknown>;

    switch (message.type) {
      case 'RUN_AGENT_TASK_FROM_PANEL': {
        if (!fromExtensionPage) return undefined; // must come from the side panel, not a page
        const msg = message as RunAgentTaskFromPanelMessage;
        void (async () => {
          await loadSessions();
          const existing = sessions.get(msg.targetTabId);
          if (existing && existing.state === 'running' && (await pingContent(msg.targetTabId))?.running) {
            sendResponse({ ok: false, error: 'A task is already running on this tab.' });
            return;
          }
          sessions.set(msg.targetTabId, {
            task: msg.payload.task,
            provider: msg.payload.provider === 'mock' ? 'mock' : 'qwen',
            visual: msg.payload.visual === true,
            history: [],
            piiMasked: 0,
            state: 'running',
            updatedAt: Date.now(),
          });
          await saveSessions();
          const r = await runSessionOnTab(msg.targetTabId).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : 'Failed to start' }));
          if (!r.ok) {
            sessions.delete(msg.targetTabId);
            await saveSessions();
          }
          sendResponse(r);
        })();
        return true;
      }

      case 'RESUME_AGENT_TASK': {
        if (!fromExtensionPage || typeof m.targetTabId !== 'number') return undefined;
        const tabId = m.targetTabId;
        void loadSessions()
          .then(() => runSessionOnTab(tabId))
          .then(sendResponse, (e: unknown) => sendResponse({ ok: false, error: String(e) }));
        return true;
      }

      case 'STOP_AGENT_TASK': {
        if (!fromExtensionPage || typeof m.targetTabId !== 'number') return undefined;
        const tabId = m.targetTabId;
        const had = sessions.get(tabId);
        sessions.delete(tabId);
        void saveSessions();
        chrome.tabs.sendMessage(tabId, { type: 'STOP_AGENT_TASK' }).catch(() => {
          // No script on the page (e.g. waiting for site access): report the stop ourselves.
          toPanel({ type: 'AGENT_TASK_COMPLETED', payload: { status: 'STOPPED', finalResult: 'You stopped the task.', steps: had?.history ?? [] } });
        });
        sendResponse({ ok: true });
        return undefined;
      }

      case 'CONFIRM_ACTION_RESPONSE': {
        if (!fromExtensionPage) return undefined; // only the user, via the side panel, can confirm
        const c = message as ConfirmActionResponseMessage;
        if (typeof c.targetTabId === 'number') chrome.tabs.sendMessage(c.targetTabId, c).catch(() => undefined);
        sendResponse({ ok: true });
        return undefined;
      }

      case 'LLM_CHAT_REQUEST':
        void proxyLlmChat(message as LlmChatRequestMessage).then(sendResponse);
        return true;

      case 'VISUAL_PERCEPTION_REQUEST': {
        const windowId = sender.tab?.windowId;
        if (typeof windowId !== 'number' || !sender.tab?.active) {
          sendResponse({ ok: false, error: 'The tab must be visible for visual perception.' });
          return undefined;
        }
        void visualPerception(m.payload as VisualRequest, windowId).then(sendResponse, (e: unknown) =>
          sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) })
        );
        return true;
      }

      // Session bookkeeping from the tab's content script.
      case 'AGENT_STEP_COMPLETED': {
        if (typeof senderTab === 'number') {
          const s = sessions.get(senderTab);
          if (s && m.step) {
            s.history.push(m.step);
            if (typeof m.piiMasked === 'number') s.piiMasked = m.piiMasked;
            s.updatedAt = Date.now();
            void saveSessions();
          }
        }
        return undefined;
      }

      case 'AGENT_NAVIGATING': {
        if (typeof senderTab === 'number') {
          const s = sessions.get(senderTab);
          if (s) {
            s.state = 'navigating';
            if (Array.isArray(m.history)) s.history = m.history;
            if (typeof m.piiMasked === 'number') s.piiMasked = m.piiMasked;
            void saveSessions();
            // If no navigation actually starts (e.g. a link that does nothing), continue here.
            const tabId = senderTab;
            setTimeout(() => {
              void (async () => {
                const cur = sessions.get(tabId);
                if (!cur || cur.state !== 'navigating') return;
                const tab = await chrome.tabs.get(tabId).catch(() => undefined);
                if (tab?.status === 'complete') await runSessionOnTab(tabId);
              })();
            }, 4000);
          }
        }
        return undefined;
      }

      case 'AGENT_TASK_COMPLETED': {
        if (typeof senderTab === 'number' && sessions.delete(senderTab)) void saveSessions();
        return undefined;
      }

      case 'DOM_SCAN_RESULT':
        handleDomScanResult(message as DomScanResultMessage, sender);
        sendResponse({ ok: true });
        return undefined;

      case 'GET_LAST_SCAN':
        void handleGetLastScan(sendResponse);
        return true;

      default:
        return undefined;
    }
  }
);

function handleDomScanResult(message: DomScanResultMessage, sender: chrome.runtime.MessageSender): void {
  const { payload } = message;
  // PRIVACY: counts only — never element values, labels, or URLs with tokens
  console.log(
    `[VeilBrowse:background] Scan received from tab ${sender.tab?.id ?? 'unknown'}.` +
      ` total=${payload.summary.total} sensitive=${payload.summary.sensitive}`
  );
  chrome.storage.session.set({ [STORAGE_KEY]: payload }).catch(() => undefined);
}

async function handleGetLastScan(sendResponse: (response: unknown) => void): Promise<void> {
  try {
    const stored = await chrome.storage.session.get(STORAGE_KEY);
    const response: LastScanResponse = stored[STORAGE_KEY] ? { found: true, result: stored[STORAGE_KEY] } : { found: false };
    sendResponse(response);
  } catch {
    sendResponse({ found: false } as LastScanResponse);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onStartup.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});
