import type { UnifiedSanitizedContext } from '@veilbrowse/shared-types';

/**
 * Outbound PII guard — the last check before anything leaves the content script.
 *
 * The classifier and redactor decide which *fields* are sensitive, but visible text
 * (button labels, link text, page titles) can still contain personal data, for example
 * a menu link "Signed in as rahul@example.com" or a title "Inbox - priya@example.com".
 * This guard scans every free-text field of the outbound context with pattern detectors,
 * replaces matches with mask tokens, and reports what it replaced. It never reads input
 * values: it only looks at text that was already going to be sent.
 */

export type PiiKind = 'EMAIL' | 'PHONE' | 'CARD' | 'AADHAAR' | 'PAN' | 'IBAN' | 'SSN' | 'UPI';

export interface PiiFinding {
  kind: PiiKind;
  field: string;
}

interface Detector {
  kind: PiiKind;
  pattern: RegExp;
  check?: (match: string) => boolean;
}

function luhnValid(digits: string): boolean {
  const d = digits.replace(/\D/g, '');
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

// Order matters: more specific patterns run first so a card number is not reported as a phone.
const DETECTORS: Detector[] = [
  { kind: 'EMAIL', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { kind: 'UPI', pattern: /\b[A-Za-z0-9._-]{2,}@(?:ok)?(?:axis|hdfc|icici|sbi|ybl|paytm|upi|ibl|apl|kotak)\b/gi },
  { kind: 'CARD', pattern: /\b(?:\d[ -]?){12,18}\d\b/g, check: luhnValid },
  { kind: 'IBAN', pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g },
  { kind: 'AADHAAR', pattern: /\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/g },
  { kind: 'PAN', pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/g },
  { kind: 'SSN', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  {
    kind: 'PHONE',
    pattern: /(?:\+\d{1,3}[ -]?)?(?:\(\d{2,4}\)[ -]?)?\d{3,5}[ -]?\d{3,4}[ -]?\d{0,4}\b/g,
    check: (m) => {
      const n = m.replace(/\D/g, '').length;
      return n >= 10 && n <= 13;
    },
  },
];

export const PII_MASK: Record<PiiKind, string> = {
  EMAIL: '[EMAIL]',
  PHONE: '[PHONE]',
  CARD: '[CARD]',
  AADHAAR: '[AADHAAR]',
  PAN: '[PAN]',
  IBAN: '[IBAN]',
  SSN: '[SSN]',
  UPI: '[UPI]',
};

/** Replace PII in one string. Returns the scrubbed text and the kinds found. */
export function scrubText(text: string): { text: string; kinds: PiiKind[] } {
  let out = text;
  const kinds: PiiKind[] = [];
  for (const det of DETECTORS) {
    out = out.replace(det.pattern, (m) => {
      if (det.check && !det.check(m)) return m;
      kinds.push(det.kind);
      return PII_MASK[det.kind];
    });
  }
  return { text: out, kinds };
}

/** Find PII in one string without changing it. */
export function findPii(text: string): PiiKind[] {
  return scrubText(text).kinds;
}

/**
 * Scrub every free-text field of the outbound context (labels, title, URL path).
 * Returns a new context; the input is not modified.
 */
export function guardOutboundContext(context: UnifiedSanitizedContext): {
  context: UnifiedSanitizedContext;
  findings: PiiFinding[];
} {
  const findings: PiiFinding[] = [];
  const scrub = (value: string | null, field: string): string | null => {
    if (!value) return value;
    const r = scrubText(value);
    for (const kind of r.kinds) findings.push({ kind, field });
    return r.text;
  };

  const elements = context.elements.map((e) => ({
    ...e,
    accessibleLabel: scrub(e.accessibleLabel, `element:${e.elementId}`),
  }));

  return {
    context: {
      ...context,
      pageTitle: scrub(context.pageTitle, 'pageTitle') ?? '',
      pageUrl: scrub(context.pageUrl, 'pageUrl') ?? '',
      elements,
    },
    findings,
  };
}

/** Count PII still present in the outbound text fields (should always be 0 after the guard).
 *  Only text fields are checked: numeric fields such as timestamps and bounds are not personal data
 *  and would trigger the phone pattern. */
export function countResidualPii(context: UnifiedSanitizedContext): number {
  let n = findPii(context.pageTitle || '').length + findPii(context.pageUrl || '').length;
  for (const e of context.elements) n += findPii(e.accessibleLabel || '').length;
  return n;
}
