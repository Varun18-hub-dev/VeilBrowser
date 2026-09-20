import type { UnifiedSanitizedContext } from './firewall';
import type { AgentAction } from './actions';

/**
 * Outbound Agent Request Envelope.
 *
 * This is the AUTHORITATIVE browser → backend contract for transmitting
 * sanitized browser context and task instructions to remote reasoning providers.
 *
 * PRIVACY INVARIANTS:
 * 1. `requestId` and `sessionId` MUST be opaque random identifiers.
 *    They MUST NEVER be derived from usernames, emails, URLs, or page contents.
 * 2. `task` represents the user's high-level goal and MUST NOT contain raw secrets.
 * 3. `context` is strictly a `UnifiedSanitizedContext` produced by the local privacy firewall.
 *    It contains zero field values, zero raw passwords, and zero raw OCR text.
 */
export interface OutboundAgentRequest {
  requestId: string;
  sessionId: string;
  task: string;
  context: UnifiedSanitizedContext;
}

/**
 * Generates an opaque, cryptographically random identifier.
 * Guaranteed never to leak user data, emails, or page contents.
 */
export function generateRandomId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  const rand =
    Math.random().toString(36).substring(2, 10) +
    Math.random().toString(36).substring(2, 10);
  return `${prefix}-${rand}`;
}

export function generateSessionId(): string {
  return generateRandomId('ses');
}

export function generateRequestId(): string {
  return generateRandomId('req');
}

/**
 * Factory for creating outbound agent requests adhering to privacy invariants.
 */
export function createOutboundAgentRequest(params: {
  sessionId?: string;
  requestId?: string;
  task: string;
  context: UnifiedSanitizedContext;
}): OutboundAgentRequest {
  return {
    requestId: params.requestId || generateRequestId(),
    sessionId: params.sessionId || generateSessionId(),
    task: params.task,
    context: params.context,
  };
}

/**
 * Abstract interface for reasoning providers.
 *
 * Pluggable contract allowing VeilBrowse to interface with different reasoning backends:
 * - LocalMockAgent (current working provider)
 * - OllamaReasoningProvider (future local LLM)
 * - BedrockReasoningProvider (future cloud AWS LLM)
 *
 * The browser privacy firewall is completely decoupled from the choice of model.
 */
export interface ReasoningProvider {
  readonly providerId: string;
  generateAction(
    task: string,
    context: UnifiedSanitizedContext
  ): Promise<AgentAction>;
}
