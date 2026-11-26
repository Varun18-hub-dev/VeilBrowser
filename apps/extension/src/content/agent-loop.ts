import type { AgentAction, UnifiedSanitizedContext } from '@veilbrowse/shared-types';
import { validateActionSchema, validateAction, executeAction } from './action-validator';
import { guardOutboundContext, countResidualPii } from './outbound-guard';

/**
 * Observe -> decide -> validate -> act loop.
 *
 * Every step re-scans the page, so the agent sees the result of its previous action
 * (a menu that opened, a new form). Every proposed action goes through Tier 1 (schema)
 * and Tier 2 (context) validation, destructive clicks need the user's confirmation, and
 * the outbound context passes the PII guard before the provider sees it.
 */

export interface StepRecord {
  step: number;
  action: string;
  targetId?: string;
  targetLabel?: string | null;
  outcome: 'EXECUTED' | 'BLOCKED' | 'REJECTED' | 'DECLINED_BY_USER' | 'FAILED';
  detail: string;
}

export type AgentStep =
  | { done: true; summary: string }
  | { done: false; action: unknown };

export interface StepProvider {
  readonly providerId: string;
  nextStep(task: string, context: UnifiedSanitizedContext, history: StepRecord[]): Promise<AgentStep>;
}

export type LoopStatus = 'COMPLETED' | 'BLOCKED' | 'STOPPED' | 'ERROR';

export interface LoopResult {
  status: LoopStatus;
  summary: string;
  providerId: string;
  steps: StepRecord[];
  /** Personal data found in visible text and masked before it reached the provider. */
  piiMasked: number;
  /** Personal data still present in what the provider received. Always 0, or the run is blocked. */
  residualPii: number;
}

export interface LoopDeps {
  task: string;
  provider: StepProvider;
  /** Fresh scan + privacy firewall for the current page state. */
  getContext: () => UnifiedSanitizedContext;
  lookup: (elementId: string) => HTMLElement | null;
  emit: (message: Record<string, unknown>) => void;
  /** Ask the user to approve a destructive action. Resolve false on decline or timeout. */
  confirm: (description: string) => Promise<boolean>;
  maxSteps?: number;
  settleMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runAgentLoop(deps: LoopDeps): Promise<LoopResult> {
  const maxSteps = deps.maxSteps ?? 8;
  const settleMs = deps.settleMs ?? 600;
  const steps: StepRecord[] = [];
  let piiMasked = 0;

  const finish = (status: LoopStatus, summary: string): LoopResult => ({
    status,
    summary,
    providerId: deps.provider.providerId,
    steps,
    piiMasked,
    residualPii: 0,
  });

  for (let i = 1; i <= maxSteps; i++) {
    // 1. Observe: fresh scan, firewall, then the outbound PII guard.
    deps.emit({ type: 'AGENT_STATUS_UPDATE', status: 'ANALYZING PAGE', currentStep: `Step ${i}: reading the page locally` });
    const guarded = guardOutboundContext(deps.getContext());
    const context = guarded.context;
    piiMasked += guarded.findings.length;
    const residual = countResidualPii(context);
    if (residual > 0) {
      return { ...finish('BLOCKED', 'Personal data could not be removed from the page context. Nothing was sent.'), residualPii: residual };
    }
    if (context.isFailClosed) {
      return finish('BLOCKED', `The privacy firewall failed closed: ${context.failureReason ?? 'unknown reason'}. Nothing was sent.`);
    }

    // 2. Decide.
    deps.emit({ type: 'AGENT_STATUS_UPDATE', status: 'REASONING', currentStep: `Step ${i}: planning on sanitized context` });
    let next: AgentStep;
    try {
      next = await deps.provider.nextStep(deps.task, context, steps);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown provider error';
      return finish('ERROR', `The reasoning model failed: ${msg}`);
    }
    if (next.done) {
      return finish('COMPLETED', next.summary || 'The agent reported the task as done.');
    }

    // 3. Validate (Tier 1 schema, Tier 2 context).
    deps.emit({ type: 'AGENT_STATUS_UPDATE', status: 'VALIDATING ACTION', currentStep: `Step ${i}: checking the proposed action` });
    const schema = validateActionSchema(next.action);
    if (!schema.valid || !schema.action) {
      steps.push({ step: i, action: String((next.action as { action?: unknown })?.action ?? 'UNKNOWN'), outcome: 'REJECTED', detail: schema.errors.join('; ') });
      return finish('BLOCKED', `The model proposed a forbidden action: ${schema.errors.join('; ')}`);
    }
    let action: AgentAction = schema.action;
    const targetId = 'targetId' in action ? action.targetId : undefined;
    const targetLabel = targetId ? context.elements.find((e) => e.elementId === targetId)?.accessibleLabel ?? null : null;

    let decision = validateAction(action, context);
    if (decision.decision === 'REQUIRES_CONFIRMATION' && action.action === 'CLICK') {
      deps.emit({ type: 'AGENT_STATUS_UPDATE', status: 'AWAITING CONFIRMATION', currentStep: `Step ${i}: waiting for your approval` });
      const approved = await deps.confirm(`Click "${targetLabel ?? targetId}"? This looks like an action that changes or submits something.`);
      if (!approved) {
        steps.push({ step: i, action: action.action, targetId, targetLabel, outcome: 'DECLINED_BY_USER', detail: 'User declined' });
        return finish('STOPPED', 'You declined the action, so the agent stopped.');
      }
      action = { ...action, confirmedByUser: true };
      decision = validateAction(action, context);
    }
    if (decision.decision !== 'APPROVED') {
      steps.push({ step: i, action: action.action, targetId, targetLabel, outcome: 'BLOCKED', detail: decision.reasons.join('; ') });
      return finish('BLOCKED', `Blocked by the safety policy: ${decision.reasons.join('; ')}`);
    }

    // 4. Act.
    deps.emit({ type: 'AGENT_STATUS_UPDATE', status: 'EXECUTING', currentStep: `Step ${i}: ${action.action}${targetLabel ? ` "${targetLabel}"` : ''}` });
    const exec = await executeAction(action, context, deps.lookup);
    const record: StepRecord = {
      step: i,
      action: action.action,
      targetId,
      targetLabel,
      outcome: exec.success ? 'EXECUTED' : 'FAILED',
      detail: exec.message,
    };
    steps.push(record);
    deps.emit({ type: 'AGENT_STEP_COMPLETED', step: record });

    if (!exec.success) return finish('ERROR', exec.message);
    if (action.action === 'NAVIGATE') {
      return finish('COMPLETED', `${exec.message}. Give the next instruction once the new page has loaded.`);
    }

    // Stop if the agent keeps repeating the same action.
    const last3 = steps.slice(-3);
    if (last3.length === 3 && last3.every((s) => s.action === record.action && s.targetId === record.targetId)) {
      return finish('STOPPED', 'The agent repeated the same action three times, so it was stopped.');
    }

    await sleep(settleMs);
  }

  return finish('STOPPED', `Stopped after ${maxSteps} steps without the model reporting the task as done.`);
}
