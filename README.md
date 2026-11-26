# VeilBrowse — A Privacy Firewall for AI Browser Agents

VeilBrowse is a Chrome extension that lets an AI agent act on web pages for you **without the model ever seeing your personal data**. You type a task in the side panel ("enable email notifications"). VeilBrowse reads the page locally, removes field values and masks anything sensitive, and sends the model only a sanitized description of the page. Every action the model proposes is checked locally before it runs, and anything that deletes, pays, sends or submits needs your approval.

The default model is **Qwen 2.5 3B running locally in Ollama**, so nothing leaves your machine. A rule-based planner is included for offline demos.

**What is enforced, and where it is tested**

| Guarantee | How | Tested by |
|---|---|---|
| Field values never leave the page | The scanner reads structure only; `ScannedElement` has no value field | unit tests, privacy invariants |
| Personal data in visible text is masked before the model sees it | Outbound PII guard (email, phone, card with Luhn check, Aadhaar, PAN, IBAN, SSN, UPI) on labels, title and URL | `agent-loop.test.ts`, e2e prompt log |
| The model can only CLICK, SCROLL, WAIT or NAVIGATE | Tier 1 closed schema | unit tests, e2e |
| No clicks on sensitive or unknown fields | Tier 2 policy, fail-closed | unit tests, e2e |
| Destructive clicks need the user | Local label check (delete, pay, send, submit, ...); the model's own flag is not trusted | unit tests, e2e (decline and approve) |
| A web page cannot drive the agent | No page bridge; the background accepts task and confirmation messages only from extension pages | e2e (hostile page) |
| Access only to sites you approve | `optional_host_permissions`, requested per site from the side panel | e2e |

---

## 1. System Architecture & Request Lifecycle

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
                            OUTBOUND PII GUARD
                 (Masks emails, phones, cards ... in visible text)
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
        RULE-BASED PLANNER   OLLAMA (qwen2.5:3b)   [FUTURE: CLOUD]
          (offline demo)      (default, local)    (not implemented)
                 └─────────┬─────────┘
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
                         USER CONFIRMATION (side panel)
                  (Delete / pay / send / submit ... clicks only)
                                     │
                                     ▼
                                  BROWSER
                       (Safe Execution via Native DOM)
                                     │
                                     ▼
                  RE-SCAN AND REPEAT (up to 8 steps, until the
                    model replies {"done": true, "summary": ...})
```

### Complete Request Lifecycle
```
User / Agent Goal
       ↓
Browser Local Perception (DOM Scan + Local OCR)
       ↓
Local Privacy Firewall (Zero Secrets Leaked)
       ↓
Outbound Request ({ requestId, sessionId, task, context: UnifiedSanitizedContext })
       ↓
Outbound PII Guard (mask personal data in visible text)
       ↓
Reasoning Provider (Ollama qwen2.5:3b via the background worker, or the rule-based planner)
       ↓
Inbound AgentAction (CLICK / SCROLL / WAIT / NAVIGATE)
       ↓
Tier 1: Local Schema Validation
       ↓
Tier 2: Local Context & Sensitivity Validation
       ↓
User confirmation for destructive clicks
       ↓
Safe Browser Execution
       ↓
Next Step / Request Cycle
```

---

## 2. Core Privacy Invariants & Contracts

### A. Authoritative Outbound Contract (`OutboundAgentRequest`)
All outbound requests are wrapped in an envelope:
```typescript
export interface OutboundAgentRequest {
  requestId: string;              // Opaque random ID (e.g. req-uuid)
  sessionId: string;              // Opaque random ID (e.g. ses-uuid)
  task: string;                   // User goal (kept separate from DOM context)
  context: UnifiedSanitizedContext; // Structural metadata only — zero field values
}
```
- **Zero Value Capture**: `input.value`, `textarea.value`, passwords, and PII are never read or stored.
- **Opaque IDs**: `requestId` and `sessionId` are cryptographically random and **never** derived from usernames, emails, URLs, or page contents.
- **URL Scrubbing**: Query parameters, tokens, and hash fragments are strictly stripped from all page URLs.

### B. Authoritative Inbound Action Contract (`AgentAction`)
Only four strictly validated actions are permitted:
```typescript
export type AgentAction =
  | { action: 'CLICK'; targetId?: string; targetCoordinates?: { x: number; y: number }; isDestructive?: boolean; confirmedByUser?: boolean }
  | { action: 'SCROLL'; direction: 'up' | 'down' | 'left' | 'right'; distance?: number }
  | { action: 'WAIT'; durationMs: number }
  | { action: 'NAVIGATE'; url: string };
```
- **Forbidden Actions**: `EXECUTE_JS`, `EVAL`, raw script injection, or arbitrary browser commands are rejected at schema validation.
- **Sensitive Target Protection**: Clicks targeting `PASSWORD`, `EMAIL`, `PHONE`, `IDENTITY`, `ADDRESS`, `PAYMENT`, or `UNKNOWN` (fail-closed) are blocked.
- **Navigation Safety**: Only `http:` and `https:` schemes are allowed; `javascript:`, `data:`, `file:`, `blob:` schemes are rejected.

### C. Pluggable Reasoning Provider Abstraction (`ReasoningProvider`)
```typescript
export interface ReasoningProvider {
  readonly providerId: string;
  generateAction(task: string, context: UnifiedSanitizedContext): Promise<AgentAction>;
}
```
- **LocalMockAgent**: The currently active, deterministic local reasoning provider.
- **OllamaReasoningProvider**: *[FUTURE — NOT IMPLEMENTED]* Local open-source model.
- **BedrockReasoningProvider**: *[FUTURE — NOT IMPLEMENTED]* Cloud model on AWS (Claude 3.5 Sonnet / Nova).

---

## 3. Future Session Store (DynamoDB) Data Minimization

When AWS DynamoDB session storage is introduced in future phases, the following data minimization invariants will be enforced:

### Allowed Future Metadata (Minimized):
- `sessionId` (opaque string)
- `requestId` (opaque string)
- `timestamp` (integer ms)
- `taskSummary` (high-level goal string without PII)
- `actionType` (`CLICK`, `SCROLL`, `WAIT`, `NAVIGATE`)
- `validationDecision` (`APPROVED`, `BLOCKED`, `REJECTED`, `REQUIRES_CONFIRMATION`)
- `validationReasons` (array of rule explanation strings)
- `latencyMs` (pipeline component latencies)
- `contextSummary` (aggregate counts: total elements, redacted count, allowed controls)
- `stepIndex` (integer)

### Strictly Forbidden in Session Storage:
- **No passwords or credentials**
- **No raw email addresses or phone numbers**
- **No government identity or payment card numbers**
- **No raw OCR text strings**
- **No screenshots or canvas pixel buffers**
- **No raw DOM trees or page HTML**
- **No unredacted URL query parameters**

---

## 4. Benchmark Performance & Scope

> **Benchmark Scope**: 100% precision, recall, F1, and redaction coverage on the 23-case synthetic benchmark.  
> *Note: VeilBrowse does not claim 100% PII detection in general. Performance reflects the 23-case synthetic benchmark suite.*

| Metric | Measured Value |
|---|---|
| **Detection Precision** | **100.00%** |
| **Detection Recall** | **100.00%** |
| **F1 Score** | **100.00%** |
| **Redaction Coverage** | **100.00%** |
| **DOM Classification Latency** | **0.22 ms** / element |
| **Visual Scan Latency** | **0.40 ms** / token |
| **Firewall Sanitization Latency** | **2.00 ms** (full page) |
| **End-to-End Local Workflow Latency** | **1.00 ms** |
| **Synthetic Secret Violations** | **0 (Zero Leakage)** |

---

## 5. Real-Browser OCR Status & Limitations

- **Automated Test Environment (Jest/Node)**: OCR token extraction, regex heuristics, spatial coordinate mapping (`screenshot -> viewport -> page`), and canvas masking (`applyVisualRedaction`) are 100% automated and verified.
- **Live Chrome Browser Runtime**: Heavy neural/WASM pixel OCR (such as Tesseract.js) is **not bundled** into the MV3 background service worker in this phase to prevent multi-megabyte bundle bloat and external WASM downloads. The visual pipeline in Chrome currently operates on structured token extraction and canvas region masking. Full neural pixel OCR in live Chrome is an explicit, documented limitation intentionally scoped for the future production OCR phase.

---

## 6. Getting Started

### Prerequisites
- Node.js 18+ and npm 9+
- Google Chrome 114+ (side panel support)
- [Ollama](https://ollama.com) with the default model, for real reasoning: `ollama pull qwen2.5:3b`

### Build and load the extension
```bash
npm install
npm run build:extension          # development build -> apps/extension/dist
```
1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, choose `apps/extension/dist`.
2. Click the VeilBrowse toolbar icon to open the side panel.
3. Open any website, type a task, click **Run Agent**. The first time on a site, Chrome asks to allow VeilBrowse on that site only.

### Let the extension reach Ollama
The background worker calls `http://127.0.0.1:11434`. Recent Ollama versions accept extension origins by default. If the side panel says *Ollama refused the request*, allow the extension origin and restart Ollama:

```bash
# Windows (then quit Ollama from the tray and start it again)
setx OLLAMA_ORIGINS "chrome-extension://*"
# macOS
launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"
# Linux
OLLAMA_ORIGINS="chrome-extension://*" ollama serve
```
No Ollama? Pick **Rule-based (offline demo)** in the side panel.

### Try it on the demo page
```bash
npm run start:demo               # http://localhost:3000
```
The demo page has fake personal data (name, email, card, address) and a notification toggle. Ask: *Open notification settings and enable email notifications*.

### Tests
```bash
npm run test:extension           # 140 unit and security tests
npm run benchmark                # 23-case synthetic detection benchmark
npm run typecheck:extension
```

End-to-end test in a real browser (loads `dist/` into Chrome and drives it from the side panel; uses a stand-in for Ollama that logs every prompt):
```bash
pip install playwright
python apps/extension/e2e/run_e2e.py --chrome "<path to Chrome for Testing or Chromium>"
```
It checks: the demo task really toggles the setting; on an ordinary site the script is injected on demand and the local-LLM path completes; none of the page's personal data appears in any prompt; declined destructive clicks don't run and approved ones do; a hostile page cannot start the agent or read its messages; `chrome://` pages are refused. Branded Chrome 137+ ignores `--load-extension`, so use Chrome for Testing or Chromium.

### Package for the Chrome Web Store
```bash
npm run package:extension        # apps/extension/veilbrowse-<version>.zip
```
The production build is minified, has no source maps, and drops the demo-only content script, so on real sites the script runs only after the user grants access. See [PRIVACY.md](PRIVACY.md) for the privacy policy.

---

## 7. Limitations

- The detection benchmark is 23 synthetic cases. It shows the rules work as designed, not real-world recall.
- Destructive-action detection is keyword-based on the target's label. An icon-only "delete" button with no label is not caught, so Tier 2 still blocks unlabeled targets only when they are sensitive.
- The e2e test uses a scripted stand-in for the model. Task success with the real Qwen 2.5 3B depends on the model and the site.
- Pixel OCR is not bundled in the live extension (see section 5).
- Navigation ends a run; give the next instruction after the new page loads.
