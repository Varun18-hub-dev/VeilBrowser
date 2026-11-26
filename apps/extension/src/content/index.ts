import { PageScanner } from './scanner';
import { applyOverlay } from './overlay';
import { runPrivacyFirewall } from './firewall';
import { LocalMockAgent } from './mock-agent';
import { OllamaReasoningProvider, type ChatTransport } from './ollama-provider';
import { runAgentLoop, type AgentStep, type StepProvider, type StepRecord } from './agent-loop';
import { guardOutboundContext } from './outbound-guard';
import {
  type DomScanResultMessage,
  type DomScanResult,
  type AgentAction,
  type UnifiedSanitizedContext,
  type LlmChatResponse,
  type ProviderChoice,
} from '@veilbrowse/shared-types';

/**
 * VeilBrowse content script.
 *
 * Runs on the page the user asked the agent to work on. It can be injected on demand
 * (the side panel asks for permission per site), so it guards against running twice.
 *
 * - Scans the page and applies the privacy overlay.
 * - Runs the agent loop for tasks sent by the side panel (via the background worker).
 * - There is no window.postMessage bridge: the web page cannot start the agent, answer
 *   its confirmation prompts, or read the sanitized context. Only extension pages can.
 *
 * PRIVACY INVARIANT: field values are never scanned or sent. The model only receives
 * UnifiedSanitizedContext after the outbound PII guard.
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
let latestScannerInstance: PageScanner | null = null;
let agentRunning = false;
const pendingConfirmations = new Map<string, (approved: boolean) => void>();

/** Send status to the side panel (extension pages only — never to the web page). */
function postToPanel(data: Record<string, unknown>): void {
  chrome.runtime.sendMessage(data).catch(() => {
    // Side panel may be closed; non-fatal.
  });
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
  latestScannerInstance = new PageScanner(handleScanUpdate);
  latestScannerInstance.start();
} catch (err: unknown) {
  console.error('[VeilBrowse] Scanner startup error — fail closed:', err);
}

function getDomElementByVeilId(id: string): HTMLElement | null {
  return document.querySelector(`[data-veil-id="${CSS.escape(id)}"]`) as HTMLElement | null;
}

function currentContext(): UnifiedSanitizedContext {
  const domScan = latestScannerInstance?.buildScanResult() || latestScanResult;
  if (!domScan) throw new Error('DOM scan result unavailable');
  return runPrivacyFirewall(domScan, null);
}

/** Model calls go through the background worker (the content script has the page's origin). */
const backgroundTransport: ChatTransport = async (model, messages) => {
  const response = (await chrome.runtime.sendMessage({
    type: 'LLM_CHAT_REQUEST',
    payload: { model, messages },
  })) as LlmChatResponse | undefined;
  if (!response?.ok || !response.content) {
    throw new Error(response?.error || 'No response from the local model');
  }
  return response.content;
};

/** Step adapter for the rule-based mock planner: re-plans each step, skips targets already clicked. */
class MockStepProvider implements StepProvider {
  public readonly providerId = 'local-mock-agent';
  private readonly agent = new LocalMockAgent();
  async nextStep(task: string, context: UnifiedSanitizedContext, history: StepRecord[]): Promise<AgentStep> {
    const clicked = new Set(history.filter((h) => h.outcome === 'EXECUTED').map((h) => h.targetId));
    const next = this.agent
      .planActions(task, context)
      .find((a: AgentAction) => a.action === 'CLICK' && !clicked.has(a.targetId));
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

async function runAgentPipeline(task: string, providerChoice: ProviderChoice): Promise<void> {
  if (agentRunning) {
    postToPanel({ type: 'AGENT_STATUS_UPDATE', status: 'ERROR', currentStep: 'A task is already running on this page.' });
    return;
  }
  agentRunning = true;
  try {
    const provider: StepProvider =
      providerChoice === 'mock' ? new MockStepProvider() : new OllamaReasoningProvider({ transport: backgroundTransport });

    const result = await runAgentLoop({
      task,
      provider,
      getContext: currentContext,
      lookup: getDomElementByVeilId,
      emit: postToPanel,
      confirm: askUserToConfirm,
    });

    const finalContext = guardOutboundContext(currentContext()).context;
    postToPanel({
      type: 'AGENT_TASK_COMPLETED',
      payload: {
        task,
        status: result.status,
        providerId: result.providerId,
        steps: result.steps,
        finalResult: result.summary,
        summary: {
          totalElements: finalContext.summary.totalElements,
          sensitiveElements: finalContext.summary.totalSensitiveRegions,
          redactedCount: finalContext.summary.redactedCount,
          allowedControls: finalContext.summary.allowedControls,
          piiMaskedInLabels: result.piiMasked,
          outboundPii: result.residualPii,
        },
      },
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    postToPanel({ type: 'AGENT_STATUS_UPDATE', status: 'ERROR', currentStep: `Agent error: ${msg}` });
  } finally {
    agentRunning = false;
  }
}

// Messages from the extension (background worker). Web pages cannot send these.
chrome.runtime.onMessage.addListener(
  (
    message: { type?: string; payload?: { task?: string; provider?: string }; confirmationId?: string; approved?: boolean },
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void
  ) => {
    if (message.type === 'PING_CONTENT') {
      sendResponse({ ok: true, ready: true });
      return;
    }
    if (message.type === 'CONFIRM_ACTION_RESPONSE' && typeof message.confirmationId === 'string') {
      pendingConfirmations.get(message.confirmationId)?.(message.approved === true);
      sendResponse({ ok: true });
      return;
    }
    if (message.type !== 'START_AGENT_TASK') return;

    const task = typeof message.payload?.task === 'string' ? message.payload.task.trim() : '';
    if (!task) {
      sendResponse({ ok: false, error: 'Empty task' });
      return;
    }
    if (agentRunning) {
      sendResponse({ ok: false, error: 'A task is already running on this page.' });
      return;
    }
    sendResponse({ ok: true });
    const providerChoice: ProviderChoice = message.payload?.provider === 'mock' ? 'mock' : 'qwen';
    void runAgentPipeline(task, providerChoice);
  }
);

} // end bootstrap

export {};
