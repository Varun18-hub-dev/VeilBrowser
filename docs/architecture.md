# VeilBrowse Architecture Overview

VeilBrowse is a privacy firewall for AI browser agents. It enforces a strict trust boundary directly inside the browser before any visual or structural context is transmitted to remote AI reasoning models.

## Core Trust Boundary

```
WEBPAGE
   ↓
LOCAL DOM + SCREEN PERCEPTION
   ↓
LOCAL SENSITIVE DATA DETECTION (Rule-based & ML)
   ↓
LOCAL REDACTION / BLOCKING
   ↓
SANITIZED CONTEXT ONLY (Structural Metadata & Masked Visuals)
   ↓
AWS (API Gateway + Lambda)
   ↓
REASONING MODEL (Amazon Bedrock)
   ↓
STRUCTURED ACTION (CLICK, SCROLL, WAIT, NAVIGATE)
   ↓
LOCAL ACTION VALIDATION (Target boundary & sensitivity check)
   ↓
BROWSER EXECUTION
```

## Privacy Guarantees & Invariants

1. **Zero Raw Value Exfiltration**:
   - `ScannedElement` records contain semantic metadata (tag name, ARIA role, bounds, interactability, sensitivity classification, accessible label) only.
   - Form inputs' `.value`, passwords, email addresses, and phone numbers are never included in scan results or messages.

2. **Stable Target Identification**:
   - Elements receive stable VeilBrowse identifiers (e.g. `vb-1`, `vb-2`).
   - Actions target elements via `elementId` rather than loose coordinates, preventing accidental interaction with sensitive elements.

3. **Restricted Browser Permissions**:
   - Manifest V3 permissions are scoped specifically to `http://localhost:3000/*` and minimal browser storage (`storage`, `activeTab`).
   - Broad permissions such as `<all_urls>`, arbitrary scripting injection, or network interception are strictly disallowed.

4. **Rule-Based Confidence Scoring**:
   - Confidence scores (e.g. 1.0 for `type="password"`, 0.9 for `autocomplete`, 0.75 for name/id heuristics) represent deterministic rule strengths, not statistically calibrated machine-learning probabilities.

---

## Phase 2: Dynamic DOM Representation Architecture

### 1. MutationObserver Strategy
- Scoped strictly to `{ childList: true, subtree: true }` on `document.documentElement`.
- Detects dynamic element insertions and removals (e.g., modals, dropdowns, single-page application navigation).
- **Attribute Mutation Boundary (Documented Limitation)**: Attribute-only modifications (such as dynamically altering `type="text"` to `type="password"` without node re-insertion) are not monitored to prevent severe performance overhead and mutation storms.

### 2. Mutation Batching via `requestAnimationFrame`
- Rapid bursts of DOM mutations are gathered in a pending batch queue.
- A single `requestAnimationFrame` is scheduled to flush changes before the next render tick.
- Multiple simultaneous DOM mutations collapse into a single unified update event.

### 3. Loop-Prevention Strategy
- The extension's visual badge container (`#veilbrowse-badges`) and styling elements are marked with `data-veil-internal="true"`.
- The mutation handler immediately filters out any mutations whose target or affected nodes are tagged with this attribute.
- Visual badge insertion or removal never triggers scanner re-execution.

### 4. Authoritative Element Identity (`WeakMap`)
- `WeakMap<Element, string>` serves as the authoritative source of truth for element identity during the page lifetime.
- DOM position is **not** identity. If an existing DOM node is re-encountered, its original `vb-N` identifier is preserved.
- The `data-veil-id` attribute on DOM nodes acts purely as a mirrored debug attribute for developer inspection.
- Removed elements are pruned from the active representation; newly added elements receive new monotonic IDs.

### 5. Open Shadow DOM Traversal & Closed Shadow DOM Boundary
- The scanner recursively inspects `element.shadowRoot` when `mode === 'open'`, detecting form fields and interactive elements inside open shadow trees (tagged with `inShadowRoot: true`).
- **Closed Shadow DOM Limitation**: By W3C specification and browser security design, closed shadow roots return `element.shadowRoot === null` to content scripts. VeilBrowse explicitly does not claim closed Shadow DOM support.

---

## Phase 3: Context-Aware Sensitivity Detector

### 1. Sensitivity Categories
VeilBrowse classifies elements into the following categories:

| Category | Description | isSensitive |
|---|---|---|
| `PASSWORD` | Credential / secret field | true |
| `EMAIL` | Email address field | true |
| `PHONE` | Phone / mobile number field | true |
| `ADDRESS` | Mailing or physical address field | true |
| `IDENTITY` | National ID, passport, account number | true |
| `PAYMENT` | Credit/debit card, CVV, expiry | true |
| `UNKNOWN` | Ambiguous or conflicting signals — fail-closed | **true** |
| `NONE` | High-confidence safe / non-sensitive field | false |

### 2. Evidence-Based Multi-Signal Model
The classifier evaluates independent signals with decreasing priority:

| Signal Source | Confidence | Example |
|---|---|---|
| `type-attr` | 1.0 | `type="password"` |
| `autocomplete` | 0.90 | `autocomplete="email"` |
| `name-attr` | 0.75 | `name="account_number"` |
| `id-attr` | 0.75 | `id="govt_id"` |
| `label-text` | 0.75 | `<label>Billing Address</label>` |
| `aria-label` | 0.70 | `aria-label="Phone"` |
| `placeholder` | 0.60 | `placeholder="Enter email"` |
| `title-attr` | 0.60 | `title="Credit card"` |
| `pattern` | 0.75–0.80 | Placeholder matches `+91 98765-43210` |
| `context-heading` | 0.60–0.65 | Nearby heading "Payment Information" |

**Multi-signal boost**: When multiple independent signals agree on the same category, confidence is boosted deterministically:
```
combinedConfidence = min(1.0, maxSignalConfidence + 0.10 × (agreeingSignals - 1))
```

This is purely rule-based arithmetic, **not** a trained probability or ML score.

### 3. Explainability
Every classification result includes a `reasons: string[]` array that logs each contributing signal as a human-readable explanation (e.g., `"label text matches 'email' keyword"`). Reasons **never** contain user-entered values.

### 4. Fail-Closed Policy

| Condition | Decision |
|---|---|
| Best category ≥ 0.70 and no conflict | High-confidence sensitive category |
| Two top categories within 0.05 of each other | `UNKNOWN` (fail-closed, `isSensitive: true`) |
| Best category 0.45–0.69 with no corroboration | `UNKNOWN` (fail-closed, `isSensitive: true`) |
| Explicit safe indicators (`type="search"`, safe keywords) | `NONE` (`isSensitive: false`) |
| No signals | `NONE` (`isSensitive: false`) |

**`UNKNOWN` is treated as potentially sensitive** by VeilBrowse's privacy policy. Future redaction and action-restriction phases will enforce restrictions on `UNKNOWN` fields.

### 5. Bounded Context Extraction
`getContextHeading(element)` extracts nearby structural heading text for contextual reinforcement. Extraction is strictly bounded to:
- Enclosing `<fieldset> > <legend>` text
- Closest `h1–h6`, `<legend>`, `.card-title`, `.section-title` within the enclosing form, section, article, `.card`, `[role="group"]`, or `[role="region"]`
- Maximum length: 80 characters

**Explicitly Prohibited:**
- `document.body.innerText`
- `document.body.textContent`
- Full-page HTML serialization
- Any broad DOM text scraping

### 6. Structural Pattern Heuristics (Metadata Only)
Evaluated on `placeholder`, `name`, and `id` attributes only — never on user-entered values:

| Pattern | Matches | Category |
|---|---|---|
| International phone format | `+91 98765-43210` in placeholder | `PHONE` |
| Email format | `name@domain.com` in placeholder | `EMAIL` |
| Card number layout | `4111 2222 3333 4444` or `MM/YY` or `CVC` | `PAYMENT` |
| Identity/SSN format | `XXX-XX-XXXX` or `VB-7729` | `IDENTITY` |

### 7. Keyword Normalization
The keyword matching normalizes separators:
- `credit_card` → compacted to `creditcard`, matched against keyword `creditcard` ✓
- `contact-number` → normalized to `contact number`, matched against keyword `contact number` ✓
- `user_mail` → matches keyword `mail` (with special-cased guard against `mailing` false-positives)

### 8. Limitations
- **No inference of visual layout**: Column/row positioning of form labels is not analyzed.
- **No cross-field analysis**: Each element is classified independently.
- **No page-level PII graph**: No attempt is made to link related fields (e.g., first name + last name + DOB = identity profile).
- **No ML or statistical calibration**: Confidence values are deterministic rule-based scores.
- **Attribute-only mutations**: If field `type` changes without DOM re-insertion, classification is not updated until the next full scan.
- **VeilBrowse does not claim to detect all possible PII**: Unusual field naming that matches no keyword and provides no context may be classified as `NONE` (safe).

---

## Phase 4: Local Privacy Decision & Redaction Engine

### 1. Privacy Decision Matrix
- `SAFE / NONE`: Marked `ALLOWED`. Accessible label preserved if non-sensitive.
- `HIGH-CONFIDENCE SENSITIVE`: Marked `REDACTED`. Accessible label replaced with category mask token.
- `UNKNOWN`: Marked `REDACTED` with opaque mask token `[REDACTED_UNKNOWN]`.
- `DETECTOR FAILURE`: Fail-closed (`isFailClosed: true`, `elements: []`).

### 2. Category Mask Tokens
- `PASSWORD` → `[REDACTED_PASSWORD]`
- `EMAIL` → `[REDACTED_EMAIL]`
- `PHONE` → `[REDACTED_PHONE]`
- `IDENTITY` → `[REDACTED_ID]`
- `ADDRESS` → `[REDACTED_ADDRESS]`
- `PAYMENT` → `[REDACTED_PAYMENT]`
- `UNKNOWN` → `[REDACTED_UNKNOWN]`

### 3. Outbound Privacy Boundary
- Function: `prepareSanitizedContext(scanResult: DomScanResult): SanitizedContext`
- Strictly filters out internal attributes, raw DOM references, and form field values.
- Strips URL query parameters and hashes.

---

## Phase 5: Local Visual Perception & Redaction

### 1. Coordinate Systems
1. **Screenshot Coordinates**: Raw pixel dimensions of the captured image buffer `(x, y, width, height)`.
2. **Viewport Coordinates**: Scaled by Device Pixel Ratio: `x_vp = x / devicePixelRatio`.
3. **Page/Document Coordinates**: Viewport coordinates + scroll offset: `x_page = x_vp + window.scrollX`.

### 2. Local OCR & Pattern Detection
- Regex heuristics identify synthetic email, phone, card numbers, CVV, identity/SSN, and physical addresses.
- **Privacy Invariant**: Raw OCR text strings are discarded immediately after categorization. Only `{ id, category, confidence, boundingBox, reasons, redacted }` is retained.

### 3. Canvas Redaction
- Bounding boxes are masked with an opaque dark rectangle (`#111827`) on a local canvas context before any export or display.

---

## Phase 6: Unified Privacy Firewall

### 1. Multi-Modal Correlation & Deduplication
- Spatial Intersection over Union (IoU) correlates overlapping DOM and visual findings (> 25% overlap).
- Correlated findings receive source `'correlated'`, preserving DOM element IDs while reinforcing confidence.
- Standalone visual findings (e.g. text in raster images) receive source `'visual'`.

### 2. Fail-Closed Boundary
- Any exception in classification, OCR, or sanitization triggers an emergency fail-closed result:
  `{ isFailClosed: true, elements: [], visualRegions: [], unifiedFindings: [] }`.

---

## Phase 7: Local Action Validation & Execution Boundary

### 1. Action Whitelist
Only four actions are permitted:
- `CLICK`: `targetId` or `targetCoordinates`.
- `SCROLL`: `direction` ('up', 'down', 'left', 'right'), `distance` (clamped to 1–2000px).
- `WAIT`: `durationMs` (clamped to 100–10000ms).
- `NAVIGATE`: `url` (strictly http: and https: only).

### 2. Strict Security Checks
- **Arbitrary Code Execution**: `EXECUTE_JS`, `EVAL`, or script strings are rejected immediately.
- **Navigation Safety**: `javascript:`, `data:`, `file:`, `blob:` schemes are rejected.
- **Sensitive Targets**: Clicks on fields categorized as PASSWORD, EMAIL, PHONE, ADDRESS, IDENTITY, PAYMENT, or UNKNOWN are blocked.
- **Blind Coordinate Clicks**: Coordinates must map to a verified safe control; clicks on empty space or sensitive visual regions are blocked.
- **Destructive Actions**: Require explicit `confirmedByUser: true`.

---

## Phase 8: Local Mock Agent Loop

### 1. Deterministic Local Planner
- Explicitly labeled: `LOCAL MOCK AGENT — NOT LLM REASONING`.
- Inspects `UnifiedSanitizedContext` without accessing raw secrets.
- Translates high-level tasks (e.g. "Open notification settings") into structured `AgentAction[]`.

### 2. Privacy-Safe Audit Logs
- Records action summary, validation decision, and timestamp.
- Invariant: Zero secret values are ever logged.

---

## Phase 9 & 10: Security Test Harness & Benchmarks

### 1. Test Harness Coverage
- 106 automated tests across 13 test suites.
- Proves zero leakage of synthetic secrets in serialized payloads across DOM, visual, URL, and action channels.

### 2. Benchmark Verification
- **Scope & Results**: 100% precision, recall, F1, and redaction coverage on the 23-case synthetic benchmark.
- *Disclaimer*: VeilBrowse does **not** claim 100% PII detection in general. Performance metrics reflect the controlled 23-case synthetic benchmark suite.
- Total local pipeline latency: ~2ms.
- Privacy Violations: 0.

---

## Phase 11 & Pre-AWS Hardening Architecture

```
                                  WEBPAGE
                                     │
                    ┌────────────────┴────────────────┐
                    ▼                                 ▼
             DOM SCANNER                     VISUAL SCANNER
         (Metadata & Structure)             (Local OCR & CV)
                    │                                 │
                    ▼                                 ▼
         SENSITIVITY CLASSIFIER              VISUAL DETECTOR
       (Multi-Signal Heuristics)           (Local Bounding Boxes)
                    │                                 │
                    └────────────────┬────────────────┘
                                     ▼
                          UNIFIED PRIVACY FIREWALL
                   (Deduplication + Fail-Closed Policy)
                                     │
                                     ▼
                          LOCAL REDACTION ENGINE
                  (Mask Tokens + URL Query Stripping)
                                     │
                      ═════════════════════════════════
                         OUTBOUND PRIVACY BOUNDARY
                      ═════════════════════════════════
                                     │
                                     ▼
                           OUTBOUND AGENT REQUEST
                 { requestId, sessionId, task, context }
                                     │
                                     ▼
                         REASONING PROVIDER INTERFACE
                  (Decoupled Pluggable Model Abstraction)
                 ┌───────────────────┬───────────────────┐
                 │                   │                   │
                 ▼                   ▼                   ▼
          LOCAL MOCK AGENT    [FUTURE: OLLAMA]    [FUTURE: BEDROCK]
         (CURRENTLY ACTIVE)    (NOT IMPLEMENTED)   (NOT IMPLEMENTED)
                 │
                 ▼
                            INBOUND AGENT ACTION
                      (CLICK, SCROLL, WAIT, NAVIGATE)
                                     │
                                     ▼
                       TIER 1: LOCAL SCHEMA VALIDATOR
                        (Rejects eval, scripts, unknown)
                                     │
                                     ▼
                       TIER 2: LOCAL SAFETY VALIDATOR
                 (Blocks sensitive targets & dangerous URLs)
                                     │
                                     ▼
                                  BROWSER
                       (Safe Execution via Native DOM)
```

---

## Pre-AWS Integration Specifications

### 1. Authoritative Outbound Contract (`OutboundAgentRequest`)
```typescript
export interface OutboundAgentRequest {
  requestId: string;              // Opaque random ID (e.g. req-uuid)
  sessionId: string;              // Opaque random ID (e.g. ses-uuid)
  task: string;                   // User goal (kept separate from DOM context)
  context: UnifiedSanitizedContext; // Structural metadata only — zero field values
}
```
- **Opaque Identifiers**: `requestId` and `sessionId` are cryptographically random strings. They are **never** derived from usernames, emails, URLs, or page contents.
- **Single Gateway**: `prepareSanitizedContext()` / `runPrivacyFirewall()` is the single authoritative gateway for constructing `UnifiedSanitizedContext`.
- **Zero Raw Value Exfiltration**: Contains no `input.value`, passwords, email addresses, phone numbers, SSNs, credit cards, or raw OCR text.

### 2. Request Lifecycle
```
User Goal / Task
       ↓
Local Perception (DOM scan + local visual detection)
       ↓
Local Privacy Firewall (Sanitization & zero-leakage guarantee)
       ↓
Outbound Request ({ requestId, sessionId, task, context })
       ↓
Reasoning Provider (Model inference)
       ↓
Inbound AgentAction
       ↓
Tier 1: Local Schema Validation
       ↓
Tier 2: Local Safety & Context Validation
       ↓
Browser Execution
       ↓
Next Request Cycle (Correlated via sessionId & new requestId)
```

### 3. Authoritative Inbound Action Contract (`AgentAction`)
Only four strictly validated actions are permitted:
```typescript
export type AgentAction =
  | { action: 'CLICK'; targetId?: string; targetCoordinates?: { x: number; y: number }; isDestructive?: boolean; confirmedByUser?: boolean }
  | { action: 'SCROLL'; direction: 'up' | 'down' | 'left' | 'right'; distance?: number }
  | { action: 'WAIT'; durationMs: number }
  | { action: 'NAVIGATE'; url: string };
```
- **Two-Tier Validation Architecture**:
  1. *Tier 1: Schema Validation (`validateActionSchema`)*: Ensures structure conforms strictly to `AgentAction`. Rejects arbitrary actions (`EXECUTE_JS`, `EVAL`), non-objects, and invalid types before contextual processing.
  2. *Tier 2: Safety & Context Validation (`validateAction`)*: Validates target exists, is interactable, and is **non-sensitive**. Blocks clicks on `PASSWORD`, `EMAIL`, `PHONE`, `IDENTITY`, `ADDRESS`, `PAYMENT`, or `UNKNOWN`. Validates coordinate bounds and restricts navigation to `http:` and `https:`.

### 4. Pluggable Reasoning Provider Abstraction (`ReasoningProvider`)
```typescript
export interface ReasoningProvider {
  readonly providerId: string;
  generateAction(task: string, context: UnifiedSanitizedContext): Promise<AgentAction>;
}
```
- **LocalMockAgent**: Currently active deterministic provider.
- **OllamaReasoningProvider**: *[FUTURE — NOT IMPLEMENTED]* Local open-source LLM provider.
- **BedrockReasoningProvider**: *[FUTURE — NOT IMPLEMENTED]* Cloud reasoning provider on AWS.

### 5. Future Session Store (DynamoDB) Data Minimization Principles
When AWS DynamoDB session storage is introduced in future cloud phases:
- **Allowed Attributes**: `sessionId`, `requestId`, `timestamp`, `taskSummary` (high-level goal without PII), `actionType`, `validationDecision`, `validationReasons`, `latencyMs`, `contextSummary` (aggregate counts: total elements, redacted count, allowed controls), `stepIndex`.
- **Forbidden Attributes**: Passwords, email values, phone values, identity numbers, payment values, raw OCR, screenshots, raw DOM, raw page HTML, unredacted URL query parameters.

### 6. Real-Browser OCR Status & Limitations
- **Jest/Node Test Environment**: Fully verified with automated test suites for OCR token parsing, regex heuristics, spatial coordinate mapping (`screenshot -> viewport -> page`), and canvas masking (`applyVisualRedaction`).
- **Live Chrome Browser Runtime**: Heavy neural/WASM pixel OCR (e.g. Tesseract.js) is **not bundled** into the MV3 background service worker in this phase to prevent multi-megabyte bundle bloat and external WASM downloads. The visual pipeline in Chrome currently operates on structured token extraction and canvas region masking. Full neural pixel OCR in live Chrome is an explicit, documented limitation intentionally scoped for the future production OCR phase.



