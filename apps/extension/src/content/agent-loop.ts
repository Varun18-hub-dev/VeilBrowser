import type { AgentAction, UnifiedSanitizedContext } from '@veilbrowse/shared-types';
import { validateActionSchema, validateAction, executeAction } from './action-validator';
import { guardOutboundContext, guardTextBlocks, countResidualPii, findPii } from './outbound-guard';

/**
 * Observe -> understand -> decide -> validate -> act loop.
 *
 * Every step re-reads the page (DOM elements, visible text and, if enabled, a redacted
 * screenshot described by a local vision model), runs the privacy firewall and the
 * outbound PII guard, asks the reasoning model for ONE action, validates it (Tier 1 schema,
 * Tier 2 policy, user confirmation for destructive actions) and executes it.
 *
 * A run can span several pages: when an action navigates, the loop stops with
 * status NAVIGATING and the background worker resumes it on the new page with the history.
 */

export interface StepRecord {
  step: number;
  action: string;
  targetId?: string;
  targetLabel?: string | null;
  /** Text the agent typed (model-generated; the model never sees page personal data). */
  text?: string;
  outcome: 'EXECUTED' | 'BLOCKED' | 'REJECTED' | 'DECLINED_BY_USER' | 'FAILED';
  detail: string;
  pageTitle?: string;
}

export type AgentStep =
  | { done: true; summary: string }
  | { done: false; action: unknown };

/** What the model is shown besides the sanitized element list. Already PII-guarded. */
export interface Observation {
  pageText: string[];
  visualNotes?: string;
}

export interface StepProvider {
  readonly providerId: string;
  nextStep(task: string, context: UnifiedSanitizedContext, history: StepRecord[], observation?: Observation): Promise<AgentStep>;
}

export type LoopStatus = 'COMPLETED' | 'BLOCKED' | 'STOPPED' | 'ERROR' | 'NAVIGATING';

export interface LoopResult {
  status: LoopStatus;
  summary: string;
  providerId: string;
  steps: StepRecord[];
  /** Personal data found in visible text and masked before it reached the model. */
  piiMasked: number;
  /** Personal data still present in what the model received. Always 0, or the run is blocked. */
  residualPii: number;
}

export interface LoopDeps {
  task: string;
  provider: StepProvider;
  /** Fresh scan + privacy firewall for the current page state. */
  getContext: () => UnifiedSanitizedContext;
  /** Visible page text with key/value personal data already redacted. */
  getPageText?: () => string[];
  /** Optional visual perception (redacted screenshot -> local vision model). */
  getVisualNotes?: (context: UnifiedSanitizedContext) => Promise<string | null>;
  lookup: (elementId: string) => HTMLElement | null;
  emit: (message: Record<string, unknown>) => void;
  /** Ask the user to approve an action. Resolve false on decline or timeout. */
  confirm: (description: string) => Promise<boolean>;
  /** True once the page is unloading or the user pressed Stop. */
  shouldStop?: () => 'navigating' | 'cancelled' | null;
  /** Steps from earlier pages of the same task. */
  history?: StepRecord[];
  piiMaskedSoFar?: number;
  /** Total step budget for the whole task, across pages. */
  maxSteps?: number;
  settleMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function describe(action: AgentAction, label: string | null | undefined): string {
  switch (action.action) {
    case 'CLICK':
      return `Click "${label ?? action.targetId ?? 'element'}"? This looks like an action that changes, sends or pays for something.`;
    case 'TYPE':
      return `Type "${action.text}" into "${label ?? action.targetId}"${action.submit ? ' and submit it' : ''}?`;
    default:
      return `Allow ${action.action}?`;
  }
}

export async function runAgentLoop(deps: LoopDeps): Promise<LoopResult> {
  const maxSteps = deps.maxSteps ?? 12;
  const settleMs = deps.settleMs ?? 700;
  const steps: StepRecord[] = [...(deps.history ?? [])];
  let piiMasked = deps.piiMaskedSoFar ?? 0;

  const finish = (status: LoopStatus, summary: string, residualPii = 0): LoopResult => ({
    status,
    summary,
    providerId: deps.provider.providerId,
    steps,
    piiMasked,
    residualPii,
  });
  const stopCheck = (): LoopResult | null => {
    const s = deps.shouldStop?.();
    if (s === 'navigating') return finish('NAVIGATING', 'Moving to the next page.');
    if (s === 'cancelled') return finish('STOPPED', 'You stopped the task.');
    return null;
  };

  while (steps.length < maxSteps) {
    const i = steps.length + 1;
    const stopped = stopCheck();
    if (stopped) return stopped;

    // 1. Inspect the page.
    deps.emit({ type: 'AGENT_STATUS_UPDATE', status: 'ANALYZING PAGE', step: i, currentStep: 'Inspecting the webpage' });
    const rawContext = deps.getContext();
    if (rawContext.isFailClosed) {
      return finish('BLOCKED', `The privacy firewall failed closed: ${rawContext.failureReason ?? 'unknown reason'}. Nothing was sent.`);
    }
    let visualNotes: string | null = null;
    if (deps.getVisualNotes) {
      deps.emit({ type: 'AGENT_STATUS_UPDATE', status: 'ANALYZING PAGE', step: i, currentStep: 'Looking at the page (local vision model)' });
      try {
        visualNotes = await deps.getVisualNotes(rawContext);
      } catch {
        visualNotes = null; // visual perception is an optional aid; the DOM path still works
      }
    }

    // 2. Privacy protection: firewall output + outbound PII guard on every text channel.
    const guarded = guardOutboundContext(rawContext);
    const text = guardTextBlocks(deps.getPageText?.() ?? [], 'pageText');
    const notes = visualNotes ? guardTextBlocks([visualNotes], 'visualNotes') : { blocks: [] as string[], findings: [] };
    piiMasked += guarded.findings.length + text.findings.length + notes.findings.length;
    const context = guarded.context;
    const observation: Observation = { pageText: text.blocks, visualNotes: notes.blocks[0] };
    const residual =
      countResidualPii(context) +
      text.blocks.reduce((n, b) => n + findPii(b).length, 0) +
      (observation.visualNotes ? findPii(observation.visualNotes).length : 0);
    if (residual > 0) {
      return finish('BLOCKED', 'Personal data could not be removed from the page context. Nothing was sent.', residual);
    }
    deps.emit({
      type: 'AGENT_STATUS_UPDATE',
      status: 'SANITIZING CONTEXT',
      step: i,
      piiMasked,
      redactedCount: context.summary.redactedCount,
      currentStep: 'Sensitive information protected locally',
    });

    // 3. Understand + decide.
    deps.emit({ type: 'AGENT_STATUS_UPDATE', status: 'REASONING', step: i, currentStep: 'Deciding the next step' });
    let next: AgentStep;
    try {
      next = await deps.provider.nextStep(deps.task, context, steps, observation);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown provider error';
      return finish('ERROR', `The reasoning model failed: ${msg}`);
    }
    const stoppedAfterThinking = stopCheck();
    if (stoppedAfterThinking) return stoppedAfterThinking;
    if (next.done) {
      return finish('COMPLETED', next.summary || 'The agent reported the task as done.');
    }

    // 4. Validate (Tier 1 schema, Tier 2 policy, user confirmation).
    deps.emit({ type: 'AGENT_STATUS_UPDATE', status: 'VALIDATING ACTION', step: i, currentStep: 'Checking the action is safe' });
    const schema = validateActionSchema(next.action);
    if (!schema.valid || !schema.action) {
      steps.push({ step: i, action: String((next.action as { action?: unknown })?.action ?? 'UNKNOWN'), outcome: 'REJECTED', detail: schema.errors.join('; ') });
      return finish('BLOCKED', `The model proposed a forbidden action: ${schema.errors.join('; ')}`);
    }
    let action: AgentAction = schema.action;
    const targetId = 'targetId' in action ? action.targetId : undefined;
    const targetLabel = targetId ? context.elements.find((e) => e.elementId === targetId)?.accessibleLabel ?? null : null;
    const typed = action.action === 'TYPE' ? action.text : undefined;

    let decision = validateAction(action, context);
    if (decision.decision === 'REQUIRES_CONFIRMATION' && (action.action === 'CLICK' || action.action === 'TYPE')) {
      deps.emit({ type: 'AGENT_STATUS_UPDATE', status: 'AWAITING CONFIRMATION', step: i, currentStep: 'Waiting for your approval' });
      const approved = await deps.confirm(describe(action, targetLabel));
      if (!approved) {
        steps.push({ step: i, action: action.action, targetId, targetLabel, text: typed, outcome: 'DECLINED_BY_USER', detail: 'User declined' });
        return finish('STOPPED', 'You declined the action, so the agent stopped.');
      }
      action = { ...action, confirmedByUser: true };
      decision = validateAction(action, context);
    }
    if (decision.decision !== 'APPROVED') {
      steps.push({ step: i, action: action.action, targetId, targetLabel, text: typed, outcome: 'BLOCKED', detail: decision.reasons.join('; ') });
      return finish('BLOCKED', `Blocked by the safety policy: ${decision.reasons.join('; ')}`);
    }

    // 5. Act.
    deps.emit({
      type: 'AGENT_STATUS_UPDATE',
      status: 'EXECUTING',
      step: i,
      currentStep: action.action === 'TYPE' ? `Typing "${action.text}"` : `${action.action[0]}${action.action.slice(1).toLowerCase()}${targetLabel ? ` "${targetLabel}"` : ''}`,
    });
    const exec = await executeAction(action, context, deps.lookup);
    const record: StepRecord = {
      step: i,
      action: action.action,
      targetId,
      targetLabel,
      text: typed,
      outcome: exec.success ? 'EXECUTED' : 'FAILED',
      detail: exec.message,
      pageTitle: context.pageTitle,
    };
    steps.push(record);
    deps.emit({ type: 'AGENT_STEP_COMPLETED', step: record, piiMasked });

    if (!exec.success) return finish('ERROR', exec.message);
    if (action.action === 'NAVIGATE') return finish('NAVIGATING', exec.message);

    // Stop if the agent keeps repeating the same action.
    const last3 = steps.slice(-3);
    if (last3.length === 3 && last3.every((s) => s.action === record.action && s.targetId === record.targetId && s.text === record.text)) {
      return finish('STOPPED', 'The agent repeated the same action three times, so it was stopped.');
    }

    await sleep(settleMs);
  }

  return finish('STOPPED', `Stopped after ${maxSteps} steps without the model reporting the task as done.`);
}
