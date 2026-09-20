# VeilBrowse — Threat Model & Security Boundaries

## 1. Executive Summary
VeilBrowse acts as an in-browser privacy firewall positioned between the user's active webpage and external AI agents or reasoning models.

Its primary goal is to prevent accidental or unauthorized exfiltration of sensitive webpage data and form input values while allowing AI agents to interact with safe, non-sensitive controls.

---

## 2. In-Scope Threats (Protected)

| Threat | Description | VeilBrowse Mitigation |
|---|---|---|
| **Accidental Exfiltration of Form Data** | An external AI agent requests full DOM state to make browsing decisions. | Form field values (`input.value`, `textarea.value`) are never accessed or serialized. Only structural metadata and masked labels cross the boundary. |
| **Credential & PII Discovery** | Fields containing passwords, emails, phones, SSNs, credit cards. | Multi-signal classifier tags elements. The Redaction Engine replaces accessible labels with explicit tokens (`[REDACTED_PASSWORD]`, etc.). |
| **Visual OCR Data Leakage** | Webpages containing rendered images or canvas elements with sensitive text. | Local OCR processes tokens in-memory only. Sensitive visual bounding boxes are masked with dark rectangles. Raw OCR strings are discarded. |
| **URL Token & Secret Leakage** | URLs containing session tokens, API keys, or user IDs in query parameters or hash fragments. | The privacy boundary sanitizes URLs by stripping query parameters (`?`) and hash fragments (`#`). |
| **Malicious Agent Actions** | An agent hallucinates or attacks by issuing clicks on credential inputs or submit buttons. | The Local Action Validator enforces an action whitelist (CLICK, SCROLL, WAIT, NAVIGATE), strictly blocking clicks on sensitive or unknown elements. |
| **Script Injection / Eval Attacks** | An agent payload attempts to execute arbitrary JavaScript (`javascript:`, `eval()`, `EXECUTE_JS`). | The Action Validator rejects any action outside the strict whitelist and forbids non-http/https URI schemes. |
| **Ambiguous / Borderline Fields** | An element has weak or conflicting privacy signals. | Fail-closed architecture: ambiguous fields are classified as `UNKNOWN` and redacted/blocked. UNKNOWN is never silently treated as safe. |

---

## 3. Out-of-Scope Threats (Not Claimed)

VeilBrowse does NOT protect against:
1. **Compromised Operating System**: Malware, keyloggers, or screen recorders running at the OS level.
2. **Malicious Browser Extensions**: Other extensions running with unrestricted host permissions (`<all_urls>`).
3. **Compromised Browser Core**: Zero-day vulnerabilities in the underlying browser rendering engine or JavaScript runtime.
4. **Physical Device Access**: An adversary with physical access to the unlocked device.
5. **Side-Channel Timing Attacks**: Sub-millisecond timing differences during local DOM processing.

---

## 4. Architectural Invariants
- **Local First**: All classification, OCR, policy evaluation, and action validation happen locally on the user's machine.
- **Fail Closed**: Detector failure, sanitizer crash, or serialization error immediately halts outbound transmission (`isFailClosed: true`).
- **Least Privilege**: Manifest V3 permissions are strictly scoped to the demo target domain.

---

## 5. Pre-AWS Integration Contracts & Boundary Enforcement

### A. Outbound Envelope Boundary (`OutboundAgentRequest`)
- Single Gateway: `prepareSanitizedContext()` and `createOutboundAgentRequest()` are the sole gateways for outbound communication.
- Opaque Identifiers: `requestId` and `sessionId` are randomly generated (`req-uuid`, `ses-uuid`). They are strictly prohibited from deriving from user data, emails, page content, or URLs.
- Zero Raw Secrets: Serialized payloads are guaranteed to contain no form field values, raw credentials, or raw OCR strings.

### B. Inbound Action Defense (`AgentAction`)
- Action Whitelist: `CLICK`, `SCROLL`, `WAIT`, `NAVIGATE` only.
- Two-Tier Local Validation:
  1. *Tier 1 (Schema)*: Strict structural check rejects script injection (`eval`, `EXECUTE_JS`), malformed payloads, and unrecognized commands.
  2. *Tier 2 (Safety)*: Contextual policy checks block clicks on sensitive targets (`PASSWORD`, `EMAIL`, `PHONE`, `IDENTITY`, `ADDRESS`, `PAYMENT`, `UNKNOWN`) and restrict navigation to `http:` and `https:`.

### C. Pluggable Reasoning Provider Abstraction (`ReasoningProvider`)
- The reasoning engine is decoupled via the `ReasoningProvider` interface.
- Current active provider: `LocalMockAgent` (deterministic, local, rule-based).
- Future providers: `OllamaReasoningProvider` (local open-source LLM), `BedrockReasoningProvider` (cloud model on AWS).
- **Status: AWS and Ollama are NOT IMPLEMENTED in this phase.**

### D. Future Cloud Session Store (DynamoDB) Data Minimization
- Permitted in future session storage: `sessionId`, `requestId`, `timestamp`, `taskSummary` (without PII), `actionType`, `validationDecision`, `validationReasons`, `latencyMs`, aggregate `contextSummary`, `stepIndex`.
- Strictly Forbidden: Passwords, email values, phone values, identity numbers, payment card numbers, raw OCR, screenshots, raw DOM, raw page HTML, unredacted URL query parameters.

### E. Real-Browser OCR Status
- Verified in automated test suites: Token parsing, regex heuristics, coordinate mapping, and canvas masking are verified in Jest/Node.
- Real Browser Limitation: Full WASM/neural pixel OCR (e.g. Tesseract.js) is not bundled in MV3 extension to avoid multi-megabyte bundle bloat. Live Chrome currently uses structured token extraction and canvas region masking. Full neural pixel OCR is scoped for future production OCR.

### F. Benchmark Scope
- 100% precision, recall, F1, and redaction coverage on the 23-case synthetic benchmark.
- VeilBrowse does not claim 100% PII detection in general.
