import { PageScanner } from './scanner';
import { applyOverlay } from './overlay';
import { runPrivacyFirewall } from './firewall';
import { LocalMockAgent } from './mock-agent';
import { OllamaReasoningProvider, type ChatTransport } from './ollama-provider';
import { runAgentLoop, type AgentStep, type Observation, type StepProvider, type StepRecord } from './agent-loop';
import { collectPageTextDetailed } from './page-text';
import { buildVisualRequest, mapMarksToIds } from './visual';
import { isSearchField } from './action-validator';
import {
  SensitiveElementType,
  type DomScanResultMessage,
  type DomScanResult,
  type AgentAction,
  type UnifiedSanitizedContext,
  type LlmChatResponse,
  type StartAgentTaskMessage,
} from '@veilbrowse/shared-types';

/**
 * VeilBrowse content script.
 *
 * Runs on the page the user asked the agent to work on. It is injected on demand (the
 * user grants access per site), so it guards against running twice.
 *
 * - Scans the page and applies the privacy overlay.
 * - Runs the agent loop for tasks sent by the background worker (which gets them from the
 *   side panel). A task may continue on the next page after a navigation.
 * - There is no window.postMessage bridge: the web page cannot start the agent, answer
 *   its confirmation prompts, or read the sanitized context. Only extension pages can.
 *
 * PRIVACY INVARIANT: field values are never read. The model only receives the sanitized
 * context, redacted page text and (optionally) notes from a local vision model that saw a
 * screenshot with sensitive regions blacked out — all after the outbound PII guard.
 */

declare global {
  interface Window {
    __veilbrowseLoaded?: boolean;
  }
}

if (!window.__veilbrowseLoaded) {
  window.__veilbrowseLoaded = true;
  bootstrap();
}

function bootstrap(): void {
  let latestScanResult: DomScanResult | null = null;
  let latestScanner: PageScanner | null = null;
  let agentRunning = false;
  let stopReason: 'navigating' | 'cancelled' | null = null;
  const pendingConfirmations = new Map<string, (approved: boolean) => void>();

  /** Status to the side panel and background (extension pages only — never the web page). */
  function postToPanel(data: Record<string, unknown>): void {
    chrome.runtime.sendMessage(data).catch(() => undefined);
  }

  function handleScanUpdate(result: DomScanResult): void {
    try {
      latestScanResult = result;
      applyOverlay(result.elements);
      const message: DomScanResultMessage = { type: 'DOM_SCAN_RESULT', payload: result };
      chrome.runtime.sendMessage(message).catch(() => undefined);
    } catch (err: unknown) {
      console.error('[VeilBrowse] Error in scan update handler:', err);
    }
  }

  try {
    latestScanner = new PageScanner(handleScanUpdate);
    latestScanner.start();
  } catch (err: unknown) {
    console.error('[VeilBrowse] Scanner startup error — fail closed:', err);
  }

  // The page is going away: stop before acting on a stale page. The background resumes.
  const onLeave = () => {
    if (agentRunning && stopReason !== 'cancelled') stopReason = 'navigating';
  };
  window.addEventListener('beforeunload', onLeave);
  window.addEventListener('pagehide', onLeave);

  function getDomElementByVeilId(id: string): HTMLElement | null {
    return document.querySelector(`[data-veil-id="${CSS.escape(id)}"]`) as HTMLElement | null;
  }

  function currentContext(): UnifiedSanitizedContext {
    const domScan = latestScanner?.buildScanResult() || latestScanResult;
    if (!domScan) throw new Error('DOM scan result unavailable');
    return runPrivacyFirewall(domScan, null);
  }

  /** Model calls go through the background worker (the content script has the page's origin). */
  const backgroundTransport: ChatTransport = async (model, messages, format) => {
    const response = (await chrome.runtime.sendMessage({ type: 'LLM_CHAT_REQUEST', payload: { model, messages, format } })) as LlmChatResponse | undefined;
    if (!response?.ok || !response.content) throw new Error(response?.error || 'No response from the local model');
    return response.content;
  };

  /** Rule-based planner for offline demos: notifications toggle, or "search for X". */
  class MockStepProvider implements StepProvider {
    public readonly providerId = 'local-mock-agent';
    private readonly agent = new LocalMockAgent();
    async nextStep(task: string, context: UnifiedSanitizedContext, history: StepRecord[], _obs?: Observation): Promise<AgentStep> {
      const search = /\b(?:search|find|look up)\s+(?:for\s+)?(?:a\s+|an\s+|the\s+)?(.+?)(?:\s+(?:under|below|less than|on|in)\b.*)?$/i.exec(task);
      if (search) {
        if (history.some((h) => h.action === 'TYPE' && h.outcome === 'EXECUTED')) {
          return { done: true, summary: `Searched for "${search[1]}".` };
        }
        const box = context.elements.find(
          (e) => e.decision === 'ALLOWED' && e.category === SensitiveElementType.NONE && e.interactable && isSearchField(e)
        );
        if (box) return { done: false, action: { action: 'TYPE', targetId: box.elementId, text: search[1], submit: true } };
      }
      const clicked = new Set(history.filter((h) => h.outcome === 'EXECUTED').map((h) => h.targetId));
      const next = this.agent.planActions(task, context).find((a: AgentAction) => a.action === 'CLICK' && !clicked.has(a.targetId));
      if (!next) {
        return { done: true, summary: history.length ? `Done after ${history.length} action(s).` : 'No safe action matched the task.' };
      }
      return { done: false, action: next };
    }
  }

  function askUserToConfirm(description: string): Promise<boolean> {
    const confirmationId = `cf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingConfirmations.delete(confirmationId);
        resolve(false); // deny on timeout
      }, 60_000);
      pendingConfirmations.set(confirmationId, (approved) => {
        clearTimeout(timer);
        pendingConfirmations.delete(confirmationId);
        resolve(approved);
      });
      postToPanel({ type: 'CONFIRM_ACTION_REQUEST', confirmationId, description });
    });
  }

  let lastRedactedTextElements: Element[] = [];
  function getPageText(): string[] {
    const r = collectPageTextDetailed(document);
    lastRedactedTextElements = r.redactedElements;
    return r.blocks;
  }

  function makeVisualNotes(task: string, visionModel: string) {
    return async (context: UnifiedSanitizedContext): Promise<string | null> => {
      getPageText(); // refresh the list of redacted text regions to black out
      const { payload, markToId } = buildVisualRequest(context, task, lastRedactedTextElements);
      const r = (await chrome.runtime.sendMessage({ type: 'VISUAL_PERCEPTION_REQUEST', payload: { ...payload, model: visionModel } })) as
        | LlmChatResponse
        | undefined;
      if (!r?.ok || !r.content) {
        postToPanel({ type: 'AGENT_STATUS_UPDATE', status: 'ANALYZING PAGE', currentStep: `Vision model unavailable (${r?.error ?? 'no response'}); using page structure only` });
        return null;
      }
      return mapMarksToIds(r.content, markToId).slice(0, 2000);
    };
  }

  async function runAgentPipeline(p: StartAgentTaskMessage['payload']): Promise<void> {
    agentRunning = true;
    stopReason = null;
    try {
      const provider: StepProvider =
        p.provider === 'mock' ? new MockStepProvider() : new OllamaReasoningProvider({ transport: backgroundTransport, modelName: p.textModel });

      const result = await runAgentLoop({
        task: p.task,
        provider,
        getContext: currentContext,
        getPageText,
        getVisualNotes: p.visual ? makeVisualNotes(p.task, p.visionModel) : undefined,
        lookup: getDomElementByVeilId,
        emit: postToPanel,
        confirm: askUserToConfirm,
        shouldStop: () => stopReason,
        history: p.history as StepRecord[],
        piiMaskedSoFar: p.piiMasked,
        maxSteps: p.maxSteps,
      });

      if (result.status === 'NAVIGATING') {
        // The background worker resumes the task on the next page with this history.
        postToPanel({ type: 'AGENT_NAVIGATING', history: result.steps, piiMasked: result.piiMasked });
        return;
      }

      let summary = { totalElements: 0, sensitiveElements: 0, redactedCount: 0, allowedControls: 0 };
      try {
        const ctx = currentContext();
        summary = {
          totalElements: ctx.summary.totalElements,
          sensitiveElements: ctx.summary.totalSensitiveRegions,
          redactedCount: ctx.summary.redactedCount,
          allowedControls: ctx.summary.allowedControls,
        };
      } catch {
        /* page changed */
      }
      postToPanel({
        type: 'AGENT_TASK_COMPLETED',
        payload: {
          task: p.task,
          status: result.status,
          providerId: result.providerId,
          steps: result.steps,
          finalResult: result.summary,
          summary: { ...summary, piiMaskedInLabels: result.piiMasked, outboundPii: result.residualPii },
        },
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      postToPanel({ type: 'AGENT_TASK_COMPLETED', payload: { task: p.task, status: 'ERROR', finalResult: `Agent error: ${msg}`, steps: p.history } });
    } finally {
      agentRunning = false;
    }
  }

  // Messages from the extension (background worker). Web pages cannot send these.
  chrome.runtime.onMessage.addListener(
    (
      message: { type?: string; payload?: StartAgentTaskMessage['payload']; confirmationId?: string; approved?: boolean },
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response: unknown) => void
    ) => {
      switch (message.type) {
        case 'PING_CONTENT':
          sendResponse({ ok: true, ready: true, running: agentRunning });
          return;
        case 'CONFIRM_ACTION_RESPONSE':
          if (typeof message.confirmationId === 'string') pendingConfirmations.get(message.confirmationId)?.(message.approved === true);
          sendResponse({ ok: true });
          return;
        case 'STOP_AGENT_TASK':
          if (agentRunning) stopReason = 'cancelled';
          for (const resolve of pendingConfirmations.values()) resolve(false);
          sendResponse({ ok: true });
          return;
        case 'START_AGENT_TASK': {
          const p = message.payload;
          if (!p || typeof p.task !== 'string' || !p.task.trim()) {
            sendResponse({ ok: false, error: 'Empty task' });
            return;
          }
          if (agentRunning) {
            sendResponse({ ok: false, error: 'A task is already running on this page.' });
            return;
          }
          sendResponse({ ok: true });
          void runAgentPipeline({ ...p, task: p.task.trim(), history: Array.isArray(p.history) ? p.history : [] });
          return;
        }
        default:
          return;
      }
    }
  );
}

export {};
