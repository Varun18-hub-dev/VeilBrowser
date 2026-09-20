import {
  type ReasoningProvider,
  type AgentAction,
  type UnifiedSanitizedContext,
} from '@veilbrowse/shared-types';

export interface OllamaProviderOptions {
  endpoint?: string;
  modelName?: string;
  temperature?: number;
}

/**
 * OllamaReasoningProvider — Local LLM Reasoning Provider using Qwen 2.5 (or any Ollama model)
 *
 * PRIVACY INVARIANTS:
 * 1. Operates SOLELY on UnifiedSanitizedContext.
 * 2. Receives only anonymized opaque identifiers (`vb-XX`), accessible labels, roles, and categories.
 * 3. Zero user passwords, raw emails, phone numbers, or card numbers are ever sent to the LLM.
 * 4. Any action returned by this provider MUST pass Tier 1 and Tier 2 browser-side validation before execution.
 */
export class OllamaReasoningProvider implements ReasoningProvider {
  public readonly providerId = 'ollama-qwen2.5:3b';
  public readonly agentType = 'LOCAL LLM REASONING (Qwen 2.5 via Ollama)';
  private readonly endpoint: string;
  private readonly modelName: string;

  constructor(options?: OllamaProviderOptions) {
    this.endpoint = options?.endpoint || 'http://127.0.0.1:11434';
    this.modelName = options?.modelName || 'qwen2.5:3b';
  }

  /**
   * Formats sanitized elements into a compact, privacy-safe JSON representation for Qwen.
   */
  private formatSanitizedElements(context: UnifiedSanitizedContext): string {
    const compactList = context.elements
      .filter((e) => e.interactable || e.decision === 'ALLOWED')
      .map((e) => ({
        id: e.elementId,
        tag: e.tagName,
        role: e.role,
        label: e.accessibleLabel || undefined,
        category: e.category,
        decision: e.decision,
      }));

    return JSON.stringify(compactList, null, 2);
  }

  /**
   * Generates a single AgentAction using the local Qwen model.
   */
  public async generateAction(
    task: string,
    context: UnifiedSanitizedContext
  ): Promise<AgentAction> {
    const actions = await this.planActions(task, context);
    return actions[0] || { action: 'WAIT', durationMs: 500 };
  }

  /**
   * Plans actions using Qwen 2.5 on Ollama.
   */
  public async planActions(
    task: string,
    context: UnifiedSanitizedContext
  ): Promise<AgentAction[]> {
    const sanitizedElementsJson = this.formatSanitizedElements(context);

    const systemPrompt =
      'You are an autonomous AI browser agent operating through the VeilBrowse privacy firewall.\n' +
      'You receive ONLY sanitized page elements where sensitive data has already been redacted.\n' +
      'Choose the best browser action to accomplish the user task.\n' +
      'Return a JSON object conforming to the AgentAction schema:\n' +
      '  {"action": "CLICK", "targetId": "elementId"}\n' +
      '  {"action": "WAIT", "durationMs": 300}\n' +
      'Do NOT attempt arbitrary scripts or invalid actions. Return ONLY valid JSON, nothing else.';

    const userPrompt =
      `User Task: "${task}"\n\n` +
      `Sanitized Interactive Elements (Opaque IDs only, zero raw secrets):\n${sanitizedElementsJson}\n\n` +
      `What is the next action to take? Respond with JSON.`;

    try {
      const response = await fetch(`${this.endpoint}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.modelName,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          stream: false,
          format: 'json',
          options: {
            temperature: 0.1,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama HTTP error ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      const content = data.message?.content?.trim();

      if (!content) {
        throw new Error('Empty response from Ollama Qwen model');
      }

      const parsed = JSON.parse(content);

      // Support array of actions or single action object
      const rawActions: unknown[] = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed.actions)
        ? parsed.actions
        : [parsed];

      const validActions: AgentAction[] = [];
      for (const item of rawActions) {
        if (item && typeof item === 'object' && 'action' in item) {
          validActions.push(item as AgentAction);
        }
      }

      if (validActions.length === 0) {
        return [{ action: 'WAIT', durationMs: 300 }];
      }

      return validActions;
    } catch (err: unknown) {
      console.warn('[VeilBrowse:OllamaProvider] Error calling Ollama:', err);
      // Return fallback wait action on network/model error
      return [{ action: 'WAIT', durationMs: 500 }];
    }
  }
}
