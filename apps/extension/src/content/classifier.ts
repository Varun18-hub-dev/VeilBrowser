import {
  SensitiveElementType,
  type SensitivityClassification,
  type SensitivitySource,
} from '@veilbrowse/shared-types';

/**
 * Flat representation of element attributes and nearby structural context
 * used as input to the classifier.
 *
 * PRIVACY CONTRACT:
 * - NEVER includes `.value` or user input contents.
 * - NEVER includes broad full-page text scraping.
 * - All fields represent semantic, structural metadata only.
 */
export interface ElementAttributes {
  tagName: string;
  type?: string;          // input[type] attribute
  name?: string;          // name attribute
  id?: string;            // id attribute
  autocomplete?: string;  // autocomplete attribute
  ariaLabel?: string;     // aria-label attribute
  placeholder?: string;   // placeholder attribute
  labelText?: string;     // associated <label> text content
  title?: string;         // title attribute
  contextHeading?: string;// nearby bounded section heading or legend
}

/**
 * An individual evidence signal discovered during analysis.
 */
interface Signal {
  type: SensitiveElementType;
  confidence: number;
  source: SensitivitySource;
  reason: string;
}

/**
 * Thresholds for fail-closed decision making:
 * - HIGH_CONFIDENCE_THRESHOLD: >= 0.70 is accepted as the identified category.
 * - AMBIGUOUS_THRESHOLD: 0.45 <= score < 0.70 without corroborating evidence
 *   fails closed to UNKNOWN (treated as sensitive).
 */
const HIGH_CONFIDENCE_THRESHOLD = 0.70;
const AMBIGUOUS_THRESHOLD = 0.45;

/**
 * Explicit safe keywords for controls like search, comments, filters, quantities.
 */
const SAFE_KEYWORDS: readonly string[] = [
  'search', 'query', 'find', 'filter', 'quantity', 'qty',
  'comment', 'feedback', 'notes', 'page_size', 'sort_by',
];

/**
 * Keywords for each sensitive category.
 */
const KEYWORDS: Readonly<Record<SensitiveElementType, readonly string[]>> = {
  [SensitiveElementType.PASSWORD]: [
    'password', 'passwd', 'pwd', 'passcode', 'security-pin', 'pin-code',
  ],
  [SensitiveElementType.EMAIL]: [
    'email', 'e-mail', 'mail',
  ],
  [SensitiveElementType.PHONE]: [
    'phone', 'tel', 'mobile', 'cell', 'fax', 'whatsapp',
    'contact-number', 'contactnumber',
  ],
  [SensitiveElementType.ADDRESS]: [
    'address', 'addr', 'street', 'city', 'state', 'zip', 'postal', 'country',
    'apartment', 'suite',
  ],
  [SensitiveElementType.IDENTITY]: [
    'ssn', 'social-security', 'account', 'accountno', 'account-number',
    'national-id', 'passport', 'license', 'govt_id', 'government-id',
    'aadhaar', 'pan-card', 'tax-id',
  ],
  [SensitiveElementType.PAYMENT]: [
    // Specific card/payment field name tokens only.
    // 'billing' and 'payment' are intentionally excluded here — they are too broad as field-name
    // keywords and cause false conflicts with fields like 'billingAddress'.
    // They remain effective as context-heading signals in evaluateContextualSignals().
    'credit-card', 'creditcard', 'debit-card', 'debitcard', 'card-number',
    'cardnumber', 'cardholder', 'cvv', 'cvc', 'csc', 'exp-month', 'exp-year',
    'expiry', 'iban', 'routing-number',
  ],
  [SensitiveElementType.UNKNOWN]: [],
  [SensitiveElementType.NONE]: [],
};

/** High-confidence: explicit input[type] mappings */
const TYPE_ATTR_MAP: Readonly<Record<string, SensitiveElementType>> = {
  password: SensitiveElementType.PASSWORD,
  email:    SensitiveElementType.EMAIL,
  tel:      SensitiveElementType.PHONE,
};

/** High-confidence: autocomplete attribute tokens */
const AUTOCOMPLETE_MAP: Readonly<Record<string, SensitiveElementType>> = {
  'current-password': SensitiveElementType.PASSWORD,
  'new-password':     SensitiveElementType.PASSWORD,
  'email':            SensitiveElementType.EMAIL,
  'tel':              SensitiveElementType.PHONE,
  'tel-national':     SensitiveElementType.PHONE,
  'street-address':   SensitiveElementType.ADDRESS,
  'address-line1':    SensitiveElementType.ADDRESS,
  'address-line2':    SensitiveElementType.ADDRESS,
  'postal-code':      SensitiveElementType.ADDRESS,
  'cc-number':        SensitiveElementType.IDENTITY,
  'cc-csc':           SensitiveElementType.IDENTITY,
  'cc-name':          SensitiveElementType.PAYMENT,
  'cc-exp':           SensitiveElementType.PAYMENT,
  'cc-exp-month':     SensitiveElementType.PAYMENT,
  'cc-exp-year':      SensitiveElementType.PAYMENT,
  'cc-type':          SensitiveElementType.PAYMENT,
};

/**
 * Lightweight structural pattern heuristics evaluated strictly on METADATA.
 * PRIVACY GUARANTEE: Never evaluates user input values.
 */
function evaluateMetadataPatterns(attrs: ElementAttributes): Signal[] {
  const signals: Signal[] = [];

  // International phone pattern in placeholder (e.g., "+1 (555) 000-0000", "+91 98765-43210")
  if (attrs.placeholder && /\+?\d{1,4}[-.\s]?\(?\d{1,4}\)?[-.\s]?\d{1,4}[-.\s]?\d{1,9}/.test(attrs.placeholder)) {
    signals.push({
      type: SensitiveElementType.PHONE,
      confidence: 0.75,
      source: 'pattern',
      reason: 'placeholder matches international phone format pattern',
    });
  }

  // Email format in placeholder (e.g. "name@example.com")
  if (attrs.placeholder && /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(attrs.placeholder)) {
    signals.push({
      type: SensitiveElementType.EMAIL,
      confidence: 0.75,
      source: 'pattern',
      reason: 'placeholder matches email format pattern',
    });
  }

  // Payment card or CVV format in placeholder (e.g. "4111 2222 3333 4444", "MM/YY", "CVC")
  if (attrs.placeholder && /(?:\d{4}[ -]?){3}\d{4}|MM\s*\/\s*YY|\bCVC\b|\bCVV\b/i.test(attrs.placeholder)) {
    signals.push({
      type: SensitiveElementType.PAYMENT,
      confidence: 0.80,
      source: 'pattern',
      reason: 'placeholder matches payment card/CVV format pattern',
    });
  }

  // Identity / SSN format in placeholder (e.g. "XXX-XX-XXXX", "VB-7729-001")
  if (attrs.placeholder && (/\b\d{3}-\d{2}-\d{4}\b|\bXXX-XX-XXXX\b|VB-\d{4}/i.test(attrs.placeholder))) {
    signals.push({
      type: SensitiveElementType.IDENTITY,
      confidence: 0.80,
      source: 'pattern',
      reason: 'placeholder matches identity/account format pattern',
    });
  }

  return signals;
}

function containsKeyword(value: string, keywords: readonly string[]): boolean {
  const lower = value.toLowerCase();
  const normalized = lower.replace(/[-_.]+/g, ' ');
  const compact = lower.replace(/[^a-z0-9]+/g, '');

  return keywords.some((kw) => {
    const kwLower = kw.toLowerCase();
    if (kwLower === 'mail') {
      // Avoid false positive on "mailing address" or "daily mail"
      if (/\bmailing\b/i.test(normalized)) return false;
      // Match if \bmail\b exists or compact ends/starts with mail
      return /\bmail\b/i.test(normalized) || /(?:^|_)mail(?:_|$)/i.test(value) || /usermail/i.test(compact);
    }

    const kwNorm = kwLower.replace(/[-_.]+/g, ' ');
    const kwCompact = kwLower.replace(/[^a-z0-9]+/g, '');

    if (normalized.includes(kwNorm)) return true;
    if (compact.includes(kwCompact)) return true;
    if (lower.includes(kwLower)) return true;

    return false;
  });
}

function keywordSignals(
  value: string,
  confidence: number,
  source: SensitivitySource,
  sourceLabel: string
): Signal[] {
  const found: Signal[] = [];
  for (const [rawType, keywords] of Object.entries(KEYWORDS)) {
    const type = rawType as SensitiveElementType;
    if (type === SensitiveElementType.NONE || type === SensitiveElementType.UNKNOWN) continue;
    if (containsKeyword(value, keywords)) {
      found.push({
        type,
        confidence,
        source,
        reason: `${sourceLabel} matches '${type}' keyword`,
      });
    }
  }
  return found;
}

/**
 * Evaluate contextual signals from nearby bounded structural headings.
 */
function evaluateContextualSignals(contextHeading: string | undefined): Signal[] {
  if (!contextHeading) return [];
  const signals: Signal[] = [];
  const lower = contextHeading.toLowerCase();

  if (containsKeyword(lower, ['payment', 'billing', 'card', 'checkout', 'credit'])) {
    signals.push({
      type: SensitiveElementType.PAYMENT,
      confidence: 0.65,
      source: 'context-heading',
      reason: `context heading '${contextHeading}' indicates payment domain`,
    });
  }

  if (containsKeyword(lower, ['identity', 'verification', 'government', 'kyc', 'profile'])) {
    signals.push({
      type: SensitiveElementType.IDENTITY,
      confidence: 0.65,
      source: 'context-heading',
      reason: `context heading '${contextHeading}' indicates identity domain`,
    });
  }

  if (containsKeyword(lower, ['security', 'credential', 'password', 'login', 'authentication'])) {
    signals.push({
      type: SensitiveElementType.PASSWORD,
      confidence: 0.65,
      source: 'context-heading',
      reason: `context heading '${contextHeading}' indicates security/credential domain`,
    });
  }

  if (containsKeyword(lower, ['address', 'shipping', 'delivery', 'location'])) {
    signals.push({
      type: SensitiveElementType.ADDRESS,
      confidence: 0.65,
      source: 'context-heading',
      reason: `context heading '${contextHeading}' indicates address domain`,
    });
  }

  if (containsKeyword(lower, ['contact', 'communication', 'phone', 'telephone'])) {
    signals.push({
      type: SensitiveElementType.PHONE,
      confidence: 0.60,
      source: 'context-heading',
      reason: `context heading '${contextHeading}' indicates contact domain`,
    });
  }

  return signals;
}

/**
 * Check if the element has explicit indicators of being a safe, non-sensitive control.
 */
function isExplicitlySafe(attrs: ElementAttributes): boolean {
  if (attrs.type === 'search') return true;
  const combined = [attrs.name, attrs.id, attrs.ariaLabel, attrs.labelText]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return SAFE_KEYWORDS.some((kw) => combined.includes(kw));
}

/**
 * Classify an element using multi-signal evidence, context, and a fail-closed policy.
 *
 * This function is PURE — it has no DOM access, no side effects, and no I/O.
 *
 * @param attrs - Element attributes and structural context (never field values)
 * @returns SensitivityClassification
 */
export function classifyElement(attrs: ElementAttributes): SensitivityClassification {
  const signals: Signal[] = [];

  // Check explicit safe indicators (e.g. search fields, comment boxes)
  // unless overridden by explicit type="password"
  const explicitlySafe = isExplicitlySafe(attrs);
  if (explicitlySafe && attrs.type?.toLowerCase() !== 'password') {
    return {
      isSensitive: false,
      type: SensitiveElementType.NONE,
      confidence: 0,
      sources: [],
      reasons: ['Explicit safe control keyword or search type matched'],
    };
  }

  // --- Confidence 1.0: explicit type attribute ---
  if (attrs.type) {
    const mapped = TYPE_ATTR_MAP[attrs.type.toLowerCase()];
    if (mapped) {
      signals.push({
        type: mapped,
        confidence: 1.0,
        source: 'type-attr',
        reason: `type='${attrs.type}' attribute explicitly specifies ${mapped}`,
      });
    }
  }

  // --- Confidence 0.90: autocomplete token ---
  if (attrs.autocomplete) {
    const mapped = AUTOCOMPLETE_MAP[attrs.autocomplete.toLowerCase()];
    if (mapped) {
      signals.push({
        type: mapped,
        confidence: 0.90,
        source: 'autocomplete',
        reason: `autocomplete='${attrs.autocomplete}' specifies ${mapped}`,
      });
    }
  }

  // --- Confidence 0.75: name and id attribute keyword match ---
  if (attrs.name) {
    signals.push(...keywordSignals(attrs.name, 0.75, 'name-attr', 'name attribute'));
  }
  if (attrs.id) {
    signals.push(...keywordSignals(attrs.id, 0.75, 'id-attr', 'id attribute'));
  }

  // --- Confidence 0.75: associated <label> text ---
  if (attrs.labelText) {
    signals.push(...keywordSignals(attrs.labelText, 0.75, 'label-text', 'label text'));
  }

  // --- Confidence 0.70: aria-label attribute ---
  if (attrs.ariaLabel) {
    signals.push(...keywordSignals(attrs.ariaLabel, 0.70, 'aria-label', 'aria-label'));
  }

  // --- Confidence 0.60: placeholder and title ---
  if (attrs.placeholder) {
    signals.push(...keywordSignals(attrs.placeholder, 0.60, 'placeholder', 'placeholder'));
  }
  if (attrs.title) {
    signals.push(...keywordSignals(attrs.title, 0.60, 'title-attr', 'title attribute'));
  }

  // --- Structural format patterns on metadata ---
  signals.push(...evaluateMetadataPatterns(attrs));

  // --- Bounded contextual heading signals ---
  signals.push(...evaluateContextualSignals(attrs.contextHeading));

  if (signals.length === 0) {
    return {
      isSensitive: false,
      type: SensitiveElementType.NONE,
      confidence: 0,
      sources: [],
      reasons: ['No sensitive signals detected'],
    };
  }

  // Group signals by category
  const categoryMap = new Map<SensitiveElementType, Signal[]>();
  for (const sig of signals) {
    const existing = categoryMap.get(sig.type) ?? [];
    existing.push(sig);
    categoryMap.set(sig.type, existing);
  }

  // Compute accumulated confidence per category
  interface CategoryResult {
    type: SensitiveElementType;
    combinedConfidence: number;
    signals: Signal[];
  }

  const categoryResults: CategoryResult[] = [];
  for (const [catType, catSignals] of categoryMap.entries()) {
    catSignals.sort((a, b) => b.confidence - a.confidence);
    const maxConf = catSignals[0].confidence;
    // Multi-signal boost formula: corroborating independent evidence increases confidence
    const boost = 0.10 * (catSignals.length - 1);
    const combined = Math.min(1.0, maxConf + boost);
    categoryResults.push({
      type: catType,
      combinedConfidence: combined,
      signals: catSignals,
    });
  }

  categoryResults.sort((a, b) => b.combinedConfidence - a.combinedConfidence);
  const best = categoryResults[0];

  // All unique sources & reasons across all signals for the winning category
  const bestSources = [...new Set(best.signals.map((s) => s.source))];
  const bestReasons = best.signals.map((s) => s.reason);

  // FAIL-CLOSED EVALUATION:
  // 1. Conflict detection: if top 2 categories have close scores (within 0.05) and different categories
  if (categoryResults.length > 1) {
    const runnerUp = categoryResults[1];
    if (Math.abs(best.combinedConfidence - runnerUp.combinedConfidence) <= 0.05 && best.type !== runnerUp.type) {
      // Special case: payment CVV/card inputs are commonly masked with type="password".
      // When both payment and password signals are present, prioritize PAYMENT.
      if (
        (best.type === SensitiveElementType.PASSWORD && runnerUp.type === SensitiveElementType.PAYMENT) ||
        (best.type === SensitiveElementType.PAYMENT && runnerUp.type === SensitiveElementType.PASSWORD)
      ) {
        return {
          isSensitive: true,
          type: SensitiveElementType.PAYMENT,
          confidence: Math.max(best.combinedConfidence, runnerUp.combinedConfidence),
          sources: [...new Set([...bestSources, ...runnerUp.signals.map((s) => s.source)])],
          reasons: [
            'Masked credential field contains payment CVV/card evidence — categorized as PAYMENT',
            ...bestReasons,
            ...runnerUp.signals.map((s) => s.reason),
          ],
        };
      }

      return {
        isSensitive: true, // Fail-closed
        type: SensitiveElementType.UNKNOWN,
        confidence: best.combinedConfidence,
        sources: [...new Set([...bestSources, ...runnerUp.signals.map((s) => s.source)])],
        reasons: [
          `Conflicting evidence between '${best.type}' (${best.combinedConfidence.toFixed(2)}) and '${runnerUp.type}' (${runnerUp.combinedConfidence.toFixed(2)})`,
          ...bestReasons,
          ...runnerUp.signals.map((s) => s.reason),
        ],
      };
    }
  }

  // 2. High confidence sensitive: >= 0.70
  if (best.combinedConfidence >= HIGH_CONFIDENCE_THRESHOLD) {
    return {
      isSensitive: true,
      type: best.type,
      confidence: best.combinedConfidence,
      sources: bestSources,
      reasons: bestReasons,
    };
  }

  // 3. Ambiguous / borderline: 0.45 <= score < 0.70 without corroboration
  if (best.combinedConfidence >= AMBIGUOUS_THRESHOLD) {
    return {
      isSensitive: true, // Fail-closed: treated as potentially sensitive
      type: SensitiveElementType.UNKNOWN,
      confidence: best.combinedConfidence,
      sources: bestSources,
      reasons: [
        `Borderline confidence (${best.combinedConfidence.toFixed(2)}) for '${best.type}' without strong corroborating evidence — fail-closed to UNKNOWN`,
        ...bestReasons,
      ],
    };
  }

  // 4. Below threshold and no strong signal -> Safe
  return {
    isSensitive: false,
    type: SensitiveElementType.NONE,
    confidence: 0,
    sources: [],
    reasons: ['Evidence below sensitivity threshold'],
  };
}

/**
 * Determine the implicit ARIA role for a given element.
 */
export function getImplicitRole(tagName: string, type?: string): string | null {
  switch (tagName.toLowerCase()) {
    case 'button': return 'button';
    case 'a':      return 'link';
    case 'select': return 'combobox';
    case 'textarea': return 'textbox';
    case 'nav':    return 'navigation';
    case 'input': {
      const inputRoles: Record<string, string> = {
        checkbox: 'checkbox',
        radio:    'radio',
        submit:   'button',
        button:   'button',
        reset:    'button',
        text:     'textbox',
        email:    'textbox',
        tel:      'textbox',
        password: 'textbox',
        number:   'spinbutton',
        range:    'slider',
        search:   'searchbox',
      };
      return inputRoles[type?.toLowerCase() ?? ''] ?? 'textbox';
    }
    default: return null;
  }
}

/**
 * Determine whether an element is user-interactable.
 * Hidden inputs are excluded.
 */
export function isInteractable(
  tagName: string,
  type?: string,
  role?: string | null
): boolean {
  const tag = tagName.toLowerCase();

  if (tag === 'input') {
    return type?.toLowerCase() !== 'hidden';
  }
  if (['button', 'select', 'textarea', 'a'].includes(tag)) {
    return true;
  }

  if (role) {
    const interactableRoles = new Set([
      'button', 'link', 'checkbox', 'radio',
      'combobox', 'listbox', 'menuitem', 'tab',
    ]);
    return interactableRoles.has(role.toLowerCase());
  }

  return false;
}
