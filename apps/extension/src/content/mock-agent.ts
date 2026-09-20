import {
  SensitiveElementType,
  type AgentAction,
  type UnifiedSanitizedContext,
  type ActionValidationResult,
  type ActionExecutionResult,
  type ReasoningProvider,
} from '@veilbrowse/shared-types';
import { validateAction, executeAction } from './action-validator';
import { runPrivacyFirewall } from './firewall';
import type { DomScanResult, VisualScanResult } from '@veilbrowse/shared-types';

/**
 * Privacy-safe audit log entry.
 * STRICT PRIVACY INVARIANT: Never contains raw secrets, emails, passwords, or PII.
 */
export interface PrivacyAuditLogEntry {
  timestamp: number;
  step: number;
  actionSummary: string;
  validationDecision: string;
  reasons: string[];
  executed: boolean;
}

/**
 * Result of executing the end-to-end local agent workflow.
 */
export interface AgentWorkflowResult {
  task: string;
  sanitizedContextSummary: {
    totalElements: number;
    sensitiveDetected: number;
    redactedCount: number;
    allowedControls: number;
    redactionCoverage: number;
  };
  plannedActions: AgentAction[];
  executionResults: ActionExecutionResult[];
  auditLogs: PrivacyAuditLogEntry[];
  completed: boolean;
}

/**
 * LOCAL MOCK AGENT — NOT LLM REASONING
 *
 * Deterministic rule-based planner used to verify the VeilBrowse privacy architecture
 * without remote LLM reasoning or external cloud services.
 * Implements the pluggable ReasoningProvider interface.
 *
 * PRIVACY CONTRACT:
 * - Operates SOLELY on UnifiedSanitizedContext.
 * - Raw secrets, passwords, or PII are never accessible to this agent.
 */
export class LocalMockAgent implements ReasoningProvider {
  public readonly providerId = 'local-mock-agent';
  public readonly agentType = 'LOCAL MOCK AGENT — NOT LLM REASONING';

  /**
   * ReasoningProvider contract implementation:
   * Deterministically returns the first planned action for the task.
   */
  public async generateAction(
    task: string,
    context: UnifiedSanitizedContext
  ): Promise<AgentAction> {
    const actions = this.planActions(task, context);
    if (actions.length === 0) {
      return { action: 'WAIT', durationMs: 500 };
    }
    return actions[0];
  }

  /**
   * Plans deterministic actions based on sanitized context and user task.
   */
  public planActions(task: string, context: UnifiedSanitizedContext): AgentAction[] {
    const actions: AgentAction[] = [];
    const normalizedTask = task.toLowerCase();

    // 1. Task: "Open notification settings and enable email notifications"
    if (
      normalizedTask.includes('notification') ||
      normalizedTask.includes('email notification') ||
      normalizedTask.includes('settings')
    ) {
      // Find safe notification button / link
      const notificationBtn = context.elements.find(
        (e) =>
          e.decision === 'ALLOWED' &&
          e.interactable &&
          e.category === SensitiveElementType.NONE &&
          (e.accessibleLabel?.toLowerCase().includes('notification') ||
            e.accessibleLabel?.toLowerCase().includes('settings'))
      );

      if (notificationBtn) {
        actions.push({ action: 'CLICK', targetId: notificationBtn.elementId });
      }

      // Find toggle or checkbox for email notifications
      const emailToggle = context.elements.find(
        (e) =>
          e.decision === 'ALLOWED' &&
          e.interactable &&
          e.category === SensitiveElementType.NONE &&
          (e.accessibleLabel?.toLowerCase().includes('email notification') ||
            e.accessibleLabel?.toLowerCase().includes('toggle') ||
            e.accessibleLabel?.toLowerCase().includes('subscribe'))
      );

      if (emailToggle && emailToggle.elementId !== notificationBtn?.elementId) {
        actions.push({ action: 'CLICK', targetId: emailToggle.elementId });
      }

      // Add small bounded wait for UI response
      actions.push({ action: 'WAIT', durationMs: 200 });
      return actions;
    }

    // 2. Generic fallback: find first safe interactable button
    const firstSafeButton = context.elements.find(
      (e) =>
        e.decision === 'ALLOWED' &&
        e.interactable &&
        e.tagName === 'button' &&
        e.category === SensitiveElementType.NONE
    );

    if (firstSafeButton) {
      actions.push({ action: 'CLICK', targetId: firstSafeButton.elementId });
    }

    return actions;
  }
}

/**
 * Runs the end-to-end Local Agent Workflow:
 * 1. Inspects page via Privacy Firewall
 * 2. Generates SanitizedContext
 * 3. Local Mock Agent plans structured actions
 * 4. Local Action Validator enforces safety rules
 * 5. Executes safe actions in local environment
 * 6. Generates safe audit log
 */
export async function runLocalAgentWorkflow(
  task: string,
  domScan: DomScanResult,
  visualScan: VisualScanResult | null = null,
  domElementLookup?: (elementId: string) => HTMLElement | null
): Promise<AgentWorkflowResult> {
  // Step 1 & 2: Local Privacy Firewall
  const sanitizedContext = runPrivacyFirewall(domScan, visualScan);

  // Step 3: Local Mock Agent planning
  const agent = new LocalMockAgent();
  const plannedActions = agent.planActions(task, sanitizedContext);

  const executionResults: ActionExecutionResult[] = [];
  const auditLogs: PrivacyAuditLogEntry[] = [];
  let allSuccess = true;

  // Step 4 & 5: Action Validation and Execution
  let stepIndex = 1;
  for (const action of plannedActions) {
    const validation: ActionValidationResult = validateAction(action, sanitizedContext);

    auditLogs.push({
      timestamp: Date.now(),
      step: stepIndex,
      actionSummary: `${action.action} ${
        'targetId' in action
          ? action.targetId
          : 'url' in action
          ? action.url
          : 'distance' in action
          ? `${action.direction} ${action.distance}px`
          : ''
      }`.trim(),
      validationDecision: validation.decision,
      reasons: validation.reasons,
      executed: validation.decision === 'APPROVED',
    });

    if (validation.decision === 'APPROVED') {
      try {
        const execResult = await executeAction(action, sanitizedContext, domElementLookup);
        executionResults.push(execResult);
      } catch {
        allSuccess = false;
        break;
      }
    } else {
      allSuccess = false;
      break;
    }

    stepIndex += 1;
  }

  return {
    task,
    sanitizedContextSummary: {
      totalElements: sanitizedContext.summary.totalElements,
      sensitiveDetected: sanitizedContext.summary.totalSensitiveRegions,
      redactedCount: sanitizedContext.summary.redactedCount,
      allowedControls: sanitizedContext.summary.allowedControls,
      redactionCoverage: sanitizedContext.redactionCoverage,
    },
    plannedActions,
    executionResults,
    auditLogs,
    completed: allSuccess && plannedActions.length > 0,
  };
}
