import {
  type ReasoningProvider,
  type AgentAction,
  type UnifiedSanitizedContext,
} from '@veilbrowse/shared-types';
import type { AgentStep, Observation, StepProvider, StepRecord } from './agent-loop';

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/** Sends chat messages to a model and returns the reply text. */
export type ChatTransport = (model: string, messages: ChatMessage[], format?: Record<string, unknown>) => Promise<string>;

/**
 * Structured-output schema: the model must state a short thought and whether the task is
 * done BEFORE choosing an action. Small models decide "done" much more reliably this way.
 */
export const STEP_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    thought: { type: 'string' },
    done: { type: 'boolean' },
    answer: { type: 'string' },
    action: { type: 'string', enum: ['CLICK', 'TYPE', 'SCROLL', 'WAIT', 'NAVIGATE', 'NONE'] },
    targetId: { type: 'string' },
    text: { type: 'string' },
    submit: { type: 'boolean' },
    direction: { type: 'string', enum: ['up', 'down'] },
    url: { type: 'string' },
    durationMs: { type: 'integer' },
  },
  required: ['thought', 'done'],
};

export interface OllamaProviderOptions {
  endpoint?: string;
  modelName?: string;
  /** How to reach the model. In the extension this goes through the background worker,
   *  because a content script runs with the website's origin and Ollama would reject it. */
  transport?: ChatTransport;
}

/** Direct HTTP transport (used outside the browser, e.g. in scripts and tests). */
export function fetchTransport(endpoint: string): ChatTransport {
  return async (model, messages, format) => {
    const response = await fetch(`${endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false, format: format ?? 'json', options: { temperature: 0.1 } }),
    });
    if (!response.ok) throw new Error(`Ollama HTTP error ${response.status}: ${response.statusText}`);
    const data = await response.json();
    const content = data.message?.content?.trim();
    if (!content) throw new Error('Empty response from the model');
    return content;
  };
}

const SYSTEM_PROMPT = `You control a web browser for the user through a privacy firewall.
Personal data is hidden as [REDACTED], [EMAIL], [NAME], etc. Never try to use it.
Each turn reply with ONE JSON object:
{"thought": "<one short sentence: what is already done and what is next>", "done": true or false,
 "answer": "<when done: the answer, or what was done>",
 "action": "CLICK|TYPE|SCROLL|WAIT|NAVIGATE", "targetId": "<id>", "text": "<for TYPE>", "submit": true, "url": "<for NAVIGATE>"}
Rules:
1. If the task asks for information and it is in the page text, set done=true and give it in "answer". Do not click.
2. If the task asks for a change and it is already true (e.g. checked=true) or the last action did it, set done=true.
3. Never repeat an action that already succeeded.
4. To search: TYPE into the search box with "submit": true, then read the results in the page text.
5. Only NAVIGATE when the task gives a URL; the url must start with http:// or https://.
6. Only use ids from the element list. SCROLL needs "direction": "down" or "up".
7. When the task asks for information, the answer must state the actual values from the page text (numbers, names, prices), not just say where they are.
Examples:
Task: "turn on dark mode". Done so far: CLICK "Dark mode" -> EXECUTED. Element: e5 | checkbox | "Dark mode" checked=true
{"thought": "Dark mode is now checked, so the task is complete.", "done": true, "answer": "Dark mode is on."}
Task: "what is my order status". Page text: "Order #123 | Shipped"
{"thought": "The status is in the page text.", "done": true, "answer": "Order #123 has shipped."}
Task: "search for headphones". Element: e2 | searchbox | "Search"
{"thought": "I need to search first.", "done": false, "action": "TYPE", "targetId": "e2", "text": "headphones", "submit": true}`;

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
  public formatElements(context: UnifiedSanitizedContext, max = 35): string {
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
    if (text.length > 1800) text = text.slice(0, 1800) + '\n…';
    const visual = observation?.visualNotes ? `\n\nVision model notes about the screenshot:\n${observation.visualNotes}` : '';
    const feedback = observation?.feedback ? `\n\nIMPORTANT: ${observation.feedback}` : '';
    return [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          `User task: "${task}"\n\nActions taken so far:\n${past}\n\n` +
          `Page: "${context.pageTitle}"\n\nVisible page text:\n${text}${visual}\n\n` +
          `Interactive elements (id | role | label | state):\n${this.formatElements(context)}${feedback}\n\nNext step (JSON only):`,
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
      const str = (v: unknown) => (typeof v === 'string' ? v : '');
      if (obj.done === true) return { done: true, summary: str(obj.answer) || str(obj.summary) || str(obj.thought) };
      if (Array.isArray(obj.actions) && obj.actions.length) return { done: false, action: obj.actions[0] };
      if (typeof obj.action === 'string' && obj.action !== 'NONE') {
        // Flat structured-output form: pick only the action fields (thought/answer are not part of the action).
        const action: Record<string, unknown> = { action: obj.action };
        for (const k of ['targetId', 'text', 'submit', 'direction', 'distance', 'url', 'durationMs']) {
          if (obj[k] !== undefined && obj[k] !== '') action[k] = obj[k];
        }
        return { done: false, action };
      }
      if (obj.action && typeof obj.action === 'object') return { done: false, action: obj.action };
    }
    throw new Error('The model returned neither an action nor done');
  }

  public async nextStep(task: string, context: UnifiedSanitizedContext, history: StepRecord[], observation?: Observation): Promise<AgentStep> {
    try {
      const content = await this.transport(this.modelName, this.buildMessages(task, context, history, observation), STEP_SCHEMA);
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
