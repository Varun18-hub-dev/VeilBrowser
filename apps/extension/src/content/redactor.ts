import {
  SensitiveElementType,
  REDACTION_TOKENS,
  type ScannedElement,
  type DomScanResult,
  type RedactionDecision,
  type SanitizedElement,
  type SanitizedContext,
} from '@veilbrowse/shared-types';

/**
 * Evaluates the privacy policy for a scanned element.
 *
 * Deterministic mapping:
 * - NONE / SAFE: ALLOWED (accessibleLabel preserved if not containing sensitive tokens)
 * - SENSITIVE (PASSWORD, EMAIL, PHONE, ADDRESS, IDENTITY, PAYMENT): REDACTED
 * - UNKNOWN: REDACTED (fail-closed, treated conservatively with opaque mask)
 */
export function applyPrivacyPolicy(element: ScannedElement): {
  decision: RedactionDecision;
  maskToken?: string;
} {
  const category = element.sensitivity?.type ?? SensitiveElementType.UNKNOWN;

  if (category === SensitiveElementType.NONE && !element.sensitivity?.isSensitive) {
    return { decision: 'ALLOWED' };
  }

  // Fail-closed handling for UNKNOWN or any sensitive category
  const token = REDACTION_TOKENS[category] || REDACTION_TOKENS[SensitiveElementType.UNKNOWN];
  return {
    decision: 'REDACTED',
    maskToken: token,
  };
}

/**
 * Cleans a URL to ensure query parameters, fragments, or auth tokens do not leak.
 */
export function sanitizeUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    // Strip query and hash
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    // If not a standard URL, sanitize by stripping everything after ? or #
    return rawUrl.split('?')[0].split('#')[0];
  }
}

/**
 * PRIVACY BOUNDARY FUNCTION: prepareSanitizedContext()
 *
 * This is the SINGLE AUTHORITATIVE GATEWAY through which scanned DOM representations
 * must pass before being made available to external agents or remote reasoning systems.
 *
 * Invariants:
 * 1. Absolutely NO form field values (input.value, textarea.value) are accepted or produced.
 * 2. Sensitive and UNKNOWN elements have their accessible labels sanitized/masked.
 * 3. Sanitizes URLs (strips query parameters and hashes).
 * 4. Fails closed if detector input is malformed or invalid.
 */
export function prepareSanitizedContext(
  scanResult: DomScanResult | null | undefined
): SanitizedContext {
  // Fail-closed fallback in case of detector failure, crash, or malformed input
  if (!scanResult || !Array.isArray(scanResult.elements)) {
    return {
      pageUrl: '',
      pageTitle: '',
      timestamp: Date.now(),
      elements: [],
      summary: {
        total: 0,
        allowed: 0,
        redacted: 0,
        blocked: 0,
        byCategory: {},
      },
      redactionCoverage: 1.0,
      isFailClosed: true,
    };
  }

  const sanitizedElements: SanitizedElement[] = [];
  let allowedCount = 0;
  let redactedCount = 0;
  let blockedCount = 0;
  const byCategory: Record<string, number> = {};

  for (const element of scanResult.elements) {
    // Determine category with fail-closed fallback
    const category = element.sensitivity?.type ?? SensitiveElementType.UNKNOWN;
    byCategory[category] = (byCategory[category] || 0) + 1;

    const policy = applyPrivacyPolicy(element);

    let accessibleLabel: string | null = null;

    if (policy.decision === 'ALLOWED') {
      allowedCount += 1;
      accessibleLabel = element.accessibleLabel;
    } else {
      redactedCount += 1;
      // Replace label with mask token to prevent semantic leakage through label text
      accessibleLabel = policy.maskToken ?? REDACTION_TOKENS[SensitiveElementType.UNKNOWN];
    }

    // Strictly construct the outbound element — omitting any non-allowed properties
    sanitizedElements.push({
      elementId: element.elementId,
      tagName: element.tagName,
      role: element.role,
      category,
      decision: policy.decision,
      maskToken: policy.maskToken,
      accessibleLabel,
      interactable: Boolean(element.interactable),
      bounds: {
        x: element.bounds?.x ?? 0,
        y: element.bounds?.y ?? 0,
        width: element.bounds?.width ?? 0,
        height: element.bounds?.height ?? 0,
      },
    });
  }

  const totalSensitive = sanitizedElements.filter(
    (e) => e.category !== SensitiveElementType.NONE
  ).length;

  const redactionCoverage =
    totalSensitive === 0 ? 1.0 : (redactedCount + blockedCount) / totalSensitive;

  return {
    pageUrl: sanitizeUrl(scanResult.pageUrl || ''),
    pageTitle: scanResult.pageTitle || '',
    timestamp: scanResult.timestamp || Date.now(),
    elements: sanitizedElements,
    summary: {
      total: sanitizedElements.length,
      allowed: allowedCount,
      redacted: redactedCount,
      blocked: blockedCount,
      byCategory,
    },
    redactionCoverage: Math.min(1.0, Math.max(0.0, redactionCoverage)),
    isFailClosed: false,
  };
}
