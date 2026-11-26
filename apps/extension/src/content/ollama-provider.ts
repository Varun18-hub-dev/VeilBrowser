import {
  type ReasoningProvider,
  type AgentAction,
  type UnifiedSanitizedContext,
} from '@veilbrowse/shared-types';
import type { AgentStep, StepProvider, StepRecord } from './agent-loop';

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/** Sends chat messages to a model and returns the reply text. */
export type ChatTransport = (model: string, messages: ChatMessage[]) => Promise<string>;

export interface OllamaProviderOptions {
  endpoint?: string;
  modelName?: string;
  /** How to reach the model. In the extension this goes through the background worker,
   *  because a content script runs with the website's origin and Ollama would reject it. */
  transport?: ChatTransport;
}

/** Direct HTTP transport (used outside the browser, e.g. in scripts and tests). */
export function fetchTransport(endpoint: string): ChatTransport {
  return async (model, messages) => {
    const response = await fetch(`${endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false, format: 'json', options: { temperature: 0.1 } }),
    });
    if (!response.ok) throw new Error(`Ollama HTTP error ${response.status}: ${response.statusText}`);
    const data = await response.json();
    const content = data.message?.content?.trim();
    if (!content) throw new Error('Empty response from the model');
    return content;
  };
}

const SYSTEM_PROMPT =
  'You are a browser agent working through the VeilBrowse privacy firewall.\n' +
  'You see ONLY sanitized page elements: personal data has been removed and masked fields are marked.\n' +
  'Each turn, choose ONE next action toward the user task, or say the task is done.\n' +
  'Reply with ONE JSON object and nothing else, in one of these forms:\n' +
  '  {"action": "CLICK", "targetId": "<id from the list>"}\n' +
  '  {"action": "SCROLL", "direction": "down"}\n' +
  '  {"action": "WAIT", "durationMs": 500}\n' +
  '  {"action": "NAVIGATE", "url": "https://..."}\n' +
  '  {"done": true, "summary": "<one sentence on what was achieved>"}\n' +
  'Only use targetIds from the list. Never target elements whose decision is not ALLOWED.\n' +
  'If the previous actions already achieved the task, reply done.';

/**
 * OllamaReasoningProvider — local LLM (default Qwen 2.5 3B) through Ollama.
 *
 * PRIVACY: it receives only UnifiedSanitizedContext (opaque ids, roles, masked labels,
 * categories). Its output is untrusted and must pass Tier 1 and Tier 2 validation.
 */
export class OllamaReasoningProvider implements ReasoningProvider, StepProvider {
  public readonly providerId: string;
  public readonly agentType = 'LOCAL LLM REASONING (Ollama)';
  private readonly modelName: string;
  private readonly transport: ChatTransport;

  constructor(options?: OllamaProviderOptions) {
    const endpoint = options?.endpoint || 'http://127.0.0.1:11434';
    this.modelName = options?.modelName || 'qwen2.5:3b';
    this.providerId = `ollama-${this.modelName}`;
    this.transport = options?.transport ?? fetchTransport(endpoint);
  }

  /** Compact, privacy-safe element list for the prompt. */
  public formatElements(context: UnifiedSanitizedContext): string {
    return JSON.stringify(
      context.elements
        .filter((e) => e.interactable || e.decision === 'ALLOWED')
        .map((e) => ({
          id: e.elementId,
          tag: e.tagName,
          role: e.role,
          label: e.accessibleLabel || undefined,
          category: e.category,
          decision: e.decision,
        }))
    );
  }

  public buildMessages(task: string, context: UnifiedSanitizedContext, history: StepRecord[]): ChatMessage[] {
    const past = history.length
      ? history.map((h) => `${h.step}. ${h.action}${h.targetLabel ? ` "${h.targetLabel}"` : h.targetId ? ` ${h.targetId}` : ''} -> ${h.outcome}`).join('\n')
      : 'none yet';
    return [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          `User task: "${task}"\n\nActions taken so far:\n${past}\n\n` +
          `Current sanitized page elements:\n${this.formatElements(context)}\n\nNext step (JSON only):`,
      },
    ];
  }

  /** Parse the model reply into a step. The action is returned raw: the caller validates it. */
  public static parseStep(content: string): AgentStep {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error('The model did not return valid JSON');
    }
    if (Array.isArray(parsed)) parsed = parsed[0];
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if (obj.done === true) return { done: true, summary: typeof obj.summary === 'string' ? obj.summary : '' };
      if (Array.isArray(obj.actions) && obj.actions.length) return { done: false, action: obj.actions[0] };
      if ('action' in obj) return { done: false, action: obj };
    }
    throw new Error('The model returned neither an action nor done');
  }

  public async nextStep(task: string, context: UnifiedSanitizedContext, history: StepRecord[]): Promise<AgentStep> {
    try {
      const content = await this.transport(this.modelName, this.buildMessages(task, context, history));
      return OllamaReasoningProvider.parseStep(content);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown model error';
      throw new Error(`Local model reasoning failed: ${message}`);
    }
  }

  /** ReasoningProvider contract: one action, no history. */
  public async generateAction(task: string, context: UnifiedSanitizedContext): Promise<AgentAction> {
    const step = await this.nextStep(task, context, []);
    if (step.done) throw new Error('The model reported the task as done without an action');
    return step.action as AgentAction;
  }
}
