import type {
  ConfirmActionResponseMessage,
  DomScanResultMessage,
  LastScanResponse,
  LlmChatRequestMessage,
  LlmChatResponse,
  RunAgentTaskFromPanelMessage,
  StartAgentTaskMessage,
  VeilBrowseMessage,
} from '@veilbrowse/shared-types';

const STORAGE_KEY = 'veilbrowse_last_scan';

/**
 * VeilBrowse Background Service Worker
 *
 * Responsibilities:
 * - Receive DOM scan results from the content script
 * - Store scan metadata in session storage (never field values)
 * - Respond to popup requests for the latest scan summary
 * - Start tasks from the side panel, injecting the content script on demand
 * - Proxy calls to the local Ollama model (content scripts run with the page's origin)
 * - Relay the user's confirmation of destructive actions back to the tab
 *
 * PRIVACY CONTRACT:
 * - We log counts and element types only
 * - We never log accessible labels, URLs with tokens, or any form values
 * - chrome.storage.session holds DomScanResult which contains metadata only
 *   (enforced by the ScannedElement type having no `value` field)
 */

const OLLAMA_ENDPOINT = 'http://127.0.0.1:11434';
const ALLOWED_MODELS = /^[a-z0-9._:-]{1,64}$/i;

/** Make sure the content script is running in the tab; inject it on demand if not. */
async function ensureContentScript(tabId: number): Promise<void> {
  try {
    const pong = (await chrome.tabs.sendMessage(tabId, { type: 'PING_CONTENT' })) as { ok?: boolean } | undefined;
    if (pong?.ok) return;
  } catch {
    // Not injected yet.
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
}

async function startTaskOnTab(message: RunAgentTaskFromPanelMessage): Promise<{ ok: boolean; error?: string }> {
  const tab = await chrome.tabs.get(message.targetTabId);
  const url = tab.url ?? '';
  if (!/^https?:\/\//.test(url)) {
    return { ok: false, error: 'VeilBrowse can only run on regular web pages (http or https).' };
  }
  try {
    await ensureContentScript(message.targetTabId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Could not access this page. Allow VeilBrowse on this site and try again. (${detail})` };
  }
  const start: StartAgentTaskMessage = { type: 'START_AGENT_TASK', payload: message.payload };
  const response = (await chrome.tabs.sendMessage(message.targetTabId, start)) as { ok: boolean; error?: string } | undefined;
  return response ?? { ok: true };
}

/** Call the local Ollama server. Runs here because the extension origin can be allowed by OLLAMA_ORIGINS. */
async function proxyLlmChat(message: LlmChatRequestMessage): Promise<LlmChatResponse> {
  const { model, messages } = message.payload;
  if (typeof model !== 'string' || !ALLOWED_MODELS.test(model) || !Array.isArray(messages)) {
    return { ok: false, error: 'Invalid model request' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const res = await fetch(`${OLLAMA_ENDPOINT}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false, format: 'json', options: { temperature: 0.1 } }),
      signal: controller.signal,
    });
    if (res.status === 403) {
      return { ok: false, error: 'Ollama refused the request. Start Ollama with OLLAMA_ORIGINS=chrome-extension://* (see README).' };
    }
    if (!res.ok) return { ok: false, error: `Ollama HTTP ${res.status}` };
    const data = (await res.json()) as { message?: { content?: string } };
    const content = data.message?.content?.trim();
    return content ? { ok: true, content } : { ok: false, error: 'Empty response from the model' };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return {
      ok: false,
      error: aborted ? 'The local model timed out' : 'Could not reach Ollama at 127.0.0.1:11434. Is it running?',
    };
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener(
  (
    message: VeilBrowseMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void
  ): boolean | undefined => {
    // Only accept messages from this extension's own pages and content scripts.
    if (sender.id !== chrome.runtime.id) return undefined;
    // Extension pages (side panel, popup) vs content scripts running inside web pages.
    const fromExtensionPage = typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));

    if (message.type === 'RUN_AGENT_TASK_FROM_PANEL') {
      if (!fromExtensionPage) return undefined; // must come from the side panel, not a page
      void startTaskOnTab(message as RunAgentTaskFromPanelMessage)
        .then(sendResponse)
        .catch((err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : 'Failed to start' }));
      return true;
    }

    if (message.type === 'LLM_CHAT_REQUEST') {
      void proxyLlmChat(message as LlmChatRequestMessage).then(sendResponse);
      return true;
    }

    if (message.type === 'CONFIRM_ACTION_RESPONSE') {
      if (!fromExtensionPage) return undefined; // only the user, via the side panel, can confirm
      const m = message as ConfirmActionResponseMessage;
      if (typeof m.targetTabId === 'number') {
        chrome.tabs.sendMessage(m.targetTabId, m).catch(() => undefined);
      }
      sendResponse({ ok: true });
      return undefined;
    }

    if (message.type === 'DOM_SCAN_RESULT') {
      handleDomScanResult(message as DomScanResultMessage, sender);
      sendResponse({ ok: true });
      return undefined;
    }

    if (message.type === 'GET_LAST_SCAN') {
      void handleGetLastScan(sendResponse);
      return true;
    }

    return undefined;
  }
);

function handleDomScanResult(
  message: DomScanResultMessage,
  sender: chrome.runtime.MessageSender
): void {
  const { payload } = message;

  // PRIVACY: log counts only — never element values, labels, or URLs with tokens
  console.log(
    `[VeilBrowse:background] Scan received from tab ${sender.tab?.id ?? 'unknown'}.` +
    ` total=${payload.summary.total} sensitive=${payload.summary.sensitive}`
  );

  // Store the full DomScanResult in session storage.
  // DomScanResult contains structural metadata only — no field values.
  chrome.storage.session.set({ [STORAGE_KEY]: payload }).catch((err: unknown) => {
    console.error('[VeilBrowse:background] Failed to store scan result:', err);
  });
}

async function handleGetLastScan(
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const stored = await chrome.storage.session.get(STORAGE_KEY);
    if (stored[STORAGE_KEY]) {
      const response: LastScanResponse = { found: true, result: stored[STORAGE_KEY] };
      sendResponse(response);
    } else {
      const response: LastScanResponse = { found: false };
      sendResponse(response);
    }
  } catch (_err) {
    const response: LastScanResponse = { found: false };
    sendResponse(response);
  }
}


chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onStartup.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});
