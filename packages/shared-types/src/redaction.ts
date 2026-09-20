import { SensitiveElementType } from './sensitivity';
import type { ElementBounds } from './dom';

/**
 * Privacy decision applied to a DOM element or visual region.
 */
export type RedactionDecision = 'ALLOWED' | 'REDACTED' | 'BLOCKED';

/**
 * Standard privacy tokens used for redacting sensitive metadata/labels.
 * Passwords and unknown secrets use opaque masks.
 */
export const REDACTION_TOKENS: Readonly<Record<SensitiveElementType, string>> = {
  [SensitiveElementType.PASSWORD]: '[REDACTED_PASSWORD]',
  [SensitiveElementType.EMAIL]: '[REDACTED_EMAIL]',
  [SensitiveElementType.PHONE]: '[REDACTED_PHONE]',
  [SensitiveElementType.IDENTITY]: '[REDACTED_ID]',
  [SensitiveElementType.ADDRESS]: '[REDACTED_ADDRESS]',
  [SensitiveElementType.PAYMENT]: '[REDACTED_PAYMENT]',
  [SensitiveElementType.UNKNOWN]: '[REDACTED_UNKNOWN]',
  [SensitiveElementType.NONE]: '',
};

/**
 * Sanitized representation of a single element allowed across the privacy boundary.
 *
 * PRIVACY INVARIANT:
 * - NEVER contains form field values (input.value, textarea.value).
 * - If the element is sensitive or UNKNOWN, any descriptive label that might echo
 *   sensitive hints is replaced by its category mask token or stripped.
 * - Only strictly needed structural and layout attributes are exported.
 */
export interface SanitizedElement {
  elementId: string;
  tagName: string;
  role: string | null;
  category: SensitiveElementType;
  decision: RedactionDecision;
  maskToken?: string;
  accessibleLabel: string | null;
  interactable: boolean;
  bounds: ElementBounds;
}

/**
 * Bounded, privacy-safe context prepared by the privacy firewall for consumption
 * by external agents or remote reasoning components.
 */
export interface SanitizedContext {
  pageUrl: string;
  pageTitle: string;
  timestamp: number;
  elements: SanitizedElement[];
  summary: {
    total: number;
    allowed: number;
    redacted: number;
    blocked: number;
    byCategory: Record<string, number>;
  };
  redactionCoverage: number; // 0.0 to 1.0
  isFailClosed?: boolean;
}
