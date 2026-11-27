import {
  type ReasoningProvider,
  type AgentAction,
  type UnifiedSanitizedContext,
} from '@veilbrowse/shared-types';
import type { AgentStep, Observation, StepProvider, StepRecord } from './agent-loop';

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
  'You see a sanitized page: interactive elements (with ids), visible page text, and sometimes notes from a vision model.\n' +
  'Personal data has been replaced with placeholders like [REDACTED], [EMAIL], [NAME]. Never try to recover or type them.\n' +
  'Each turn, choose ONE next action toward the user task, or finish.\n' +
  'Reply with ONE JSON object and nothing else, in one of these forms:\n' +
  '  {"action": "CLICK", "targetId": "<id>"}\n' +
  '  {"action": "TYPE", "targetId": "<id of a text field>", "text": "<text>", "submit": true}\n' +
  '  {"action": "SCROLL", "direction": "down"}\n' +
  '  {"action": "WAIT", "durationMs": 1000}\n' +
  '  {"action": "NAVIGATE", "url": "https://..."}\n' +
  '  {"done": true, "summary": "<what was done, or the answer the user asked for>"}\n' +
  'Rules: only use ids from the element list; ' +
  'if the task asks a question and the answer is in the page text, answer it in the summary right away; ' +
  'check the state column (checked=true means a setting is already on) and the actions taken so far: ' +
  'if the task is already achieved, finish. Never repeat an action that already succeeded.';

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

  /** Compact, privacy-safe element list: one line per element, sized for a 4k context. */
  public formatElements(context: UnifiedSanitizedContext, max = 45): string {
    const lines: string[] = [];
    let masked = 0;
    for (const e of context.elements) {
      if (e.decision !== 'ALLOWED') {
        masked++;
        continue;
      }
      if (!e.interactable || lines.length >= max) continue;
      const label = (e.accessibleLabel ?? '').replace(/\s+/g, ' ').slice(0, 60);
      const st = e.state
        ? ' ' + Object.entries(e.state).map(([k, v]) => `${k}=${v}`).join(' ')
        : '';
      lines.push(`${e.elementId} | ${e.role ?? e.tagName} | "${label}"${st}`);
    }
    if (masked) lines.push(`(${masked} private fields hidden; do not use them)`);
    return lines.join('\n');
  }

  public buildMessages(task: string, context: UnifiedSanitizedContext, history: StepRecord[], observation?: Observation): ChatMessage[] {
    const past = history.length
      ? history
          .map((h) => {
            const what = h.action === 'TYPE' ? `TYPE "${h.text ?? ''}" into "${h.targetLabel ?? h.targetId}"` : `${h.action}${h.targetLabel ? ` "${h.targetLabel}"` : h.targetId ? ` ${h.targetId}` : ''}`;
            return `${h.step}. ${what} -> ${h.outcome}${h.pageTitle ? ` (on "${h.pageTitle}")` : ''}`;
          })
          .join('\n')
      : 'none yet';
    let text = observation?.pageText?.length ? observation.pageText.join('\n') : '(no readable text)';
    if (text.length > 2500) text = text.slice(0, 2500) + '\n…';
    const visual = observation?.visualNotes ? `\n\nVision model notes about the screenshot:\n${observation.visualNotes}` : '';
    return [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          `User task: "${task}"\n\nActions taken so far:\n${past}\n\n` +
          `Page: "${context.pageTitle}"\n\nVisible page text:\n${text}${visual}\n\n` +
          `Interactive elements (id | role | label | state):\n${this.formatElements(context)}\n\nNext step (JSON only):`,
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

  public async nextStep(task: string, context: UnifiedSanitizedContext, history: StepRecord[], observation?: Observation): Promise<AgentStep> {
    try {
      const content = await this.transport(this.modelName, this.buildMessages(task, context, history, observation));
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
