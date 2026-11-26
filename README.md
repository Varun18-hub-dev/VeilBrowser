# VeilBrowse — A Privacy-Preserving AI Browser Agent

VeilBrowse is a Chrome extension that lets an AI agent use websites for you **without the model ever seeing your personal data**. You type a task in the side panel: *"Find the cheapest laptop under ₹60,000"*, *"Open my college portal and check my attendance"*, *"Enable email notifications"*. The agent works in an observe → understand → decide → act loop, across pages, until it is done.

- **Perception:** DOM scan of interactive elements, privacy-safe reading of visible page text, and (optional) a screenshot with private areas blacked out, described by a **local vision model** (default `qwen2.5vl:3b`), which also reads text that only exists as images.
- **Local privacy firewall:** field values are never read; personal values in page text (`Name: Ajay Kumar` → `Name: [REDACTED]`), emails, phones, cards, ID numbers and greeting names are removed before any model sees the page.
- **Reasoning:** **Qwen 2.5 3B running locally in Ollama** picks one structured action at a time: `CLICK`, `TYPE`, `SCROLL`, `WAIT`, `NAVIGATE`, or `done` with an answer.
- **Validation and execution:** Tier 1 schema check, Tier 2 security check, your approval for anything that deletes, pays, sends or submits; the extension is the only thing that touches the page.

**What is enforced, and where it is tested**

| Guarantee | How | Tested by |
|---|---|---|
| Field values never leave the page | The scanner reads structure only; `ScannedElement` has no value field | unit tests, privacy invariants |
| Personal data in visible text is masked before the model sees it | Outbound PII guard (email, phone, card with Luhn check, Aadhaar, PAN, IBAN, SSN, UPI) on labels, title and URL | `agent-loop.test.ts`, e2e prompt log |
| Personal values in page text are removed | Key/value, table-row, `dt`/`dd` and label/value redaction, then the PII guard | `perception.test.ts` on the demo pages, e2e prompt log |
| Screenshots hide what the text hides | Sensitive fields and redacted text are filled black before the vision model sees the image; its notes go through the PII guard | e2e (pixel check on the image the model received) |
| The model can only CLICK, TYPE, SCROLL, WAIT or NAVIGATE | Tier 1 closed schema | unit tests, e2e |
| No clicks or typing on sensitive or unknown fields | Tier 2 policy, fail-closed; placeholders like `[EMAIL]` can never be typed back | unit tests, e2e |
| Typing personal data or submitting a non-search form needs the user | Tier 2 → confirmation | unit tests |
| Destructive clicks need the user | Local label check (delete, pay, send, submit, ...); the model's own flag is not trusted | unit tests, e2e (decline and approve) |
| A web page cannot drive the agent | No page bridge; the background accepts task and confirmation messages only from extension pages | e2e (hostile page) |
| Access only to sites you approve | `optional_host_permissions`, requested per site; if a task moves to a new site, the panel asks before reading it | e2e |

---

## 1. System Architecture & Request Lifecycle

```
                                  WEBPAGE
                                     │
                    ┌────────────────┴────────────────┐
                    ▼                                 ▼
       DOM SCANNER + PAGE TEXT          REDACTED SCREENSHOT
   (Structure, labels, visible text)   (Sensitive areas blacked out)
                    │                                 │
                    ▼                                 ▼
         SENSITIVITY CLASSIFIER           LOCAL VISION MODEL
       (Multi-Signal Heuristics)       (qwen2.5vl:3b, optional)
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
                   (CLICK, TYPE, SCROLL, WAIT, NAVIGATE)
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
              RE-SCAN AND REPEAT, ALSO ACROSS PAGE NAVIGATIONS
           (up to 15 steps, until the model replies {"done": true,
                         "summary": "<answer>"})
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
Inbound AgentAction (CLICK / TYPE / SCROLL / WAIT / NAVIGATE)
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

## 5. Visual Perception and OCR

Visual mode is optional (side panel → Settings → *Look at the page visually*).

1. The background worker screenshots the visible tab.
2. Every sensitive field and every text block whose value was redacted is filled **black** (the screenshot hides exactly what the text hides). Allowed controls get numbered boxes (set-of-marks).
3. The image goes to a **local** vision model in Ollama (default `qwen2.5vl:3b`). It describes the layout, says which numbered controls matter for the task, and reads text that exists only in images. That is the OCR path in the live extension; no separate OCR engine is bundled.
4. The model's notes pass the PII guard, box numbers are mapped back to element ids, and the notes are added to the reasoner's context.

Chrome only allows screenshots for extensions with access to all sites (`<all_urls>`) or `activeTab`, so turning visual mode on asks for the all-sites permission. Without visual mode, VeilBrowse asks per site. If the vision model is missing or fails, the agent continues with page structure and text.

The regex-based visual PII detector in `visual-scanner.ts` (OCR tokens → sensitive regions) is tested in Jest but not wired into the live extension.

---

## 6. Getting Started

### Prerequisites
- Node.js 18+ and npm 9+
- Google Chrome 114+ (side panel support)
- [Ollama](https://ollama.com) with the default models: `ollama pull qwen2.5:3b` (reasoning) and, for visual mode, `ollama pull qwen2.5vl:3b`

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
No Ollama? Pick **Rule-based (offline demo)** under Settings. Model names can also be changed there.

### Try it on the demo page
```bash
npm run start:demo               # http://localhost:3000
```
All pages contain fake personal data. Try:
- `index.html`: *Open notification settings and enable email notifications*
- `shop.html`: *Find the cheapest laptop under ₹60,000* (types a search, follows the results page, answers)
- `portal.html`: *Check my attendance* (reads a table next to a profile full of personal data)

### Tests
```bash
npm run test:extension           # 157 unit and security tests
npm run benchmark                # 23-case synthetic detection benchmark
npm run typecheck:extension
```

End-to-end test in a real browser. It loads `dist/` into Chrome and drives the real side panel (types the task, clicks Run, answers prompts). A stand-in for Ollama logs every prompt and screenshot the models receive:
```bash
pip install playwright pillow
python apps/extension/e2e/run_e2e.py --chrome "<path to Chrome for Testing or Chromium>"
```
15 checks, including:
- the search task types, follows the results page and answers correctly;
- the attendance task is answered from redacted text;
- in the screenshot sent to the vision model, the personal fields and the greeting are black and the attendance table is not;
- vision notes reach the reasoner with marks mapped and PII removed;
- the panel asks before reading a new site;
- **none of the page's personal data appears in any prompt**;
- destructive clicks need approval;
- a hostile page cannot drive the agent.

**With the real models:** run Ollama on another port and let the harness proxy and log it. The same privacy checks then run against real Qwen output, and the task checks measure whether the model actually solves them:
```bash
OLLAMA_HOST=127.0.0.1:11435 ollama serve          # Windows: set OLLAMA_HOST=127.0.0.1:11435 && ollama serve
python apps/extension/e2e/run_e2e.py --chrome "<chrome>" --real-ollama http://127.0.0.1:11435
```
Branded Chrome 137+ ignores `--load-extension`, so use Chrome for Testing or Chromium.

### Package for the Chrome Web Store
```bash
npm run package:extension        # apps/extension/veilbrowse-<version>.zip
```
The production build is minified, has no source maps, and drops the demo-only content script, so on real sites the script runs only after the user grants access. See [PRIVACY.md](PRIVACY.md) for the privacy policy.

---

## 7. Limitations

- Names are only caught as key/value text ("Name: …"), next to a "Name" label, or after greetings ("Signed in as …"). A name in free text elsewhere (e.g. a chat message) is not detected; a local NER model would be the next step.
- The detection benchmark is 23 synthetic cases. It shows the rules work as designed, not real-world recall.
- Destructive-action detection is keyword-based on the target's label; an unlabeled icon button is not recognized as destructive.
- The e2e suite's task checks use scripted model replies by default; run it with `--real-ollama` to measure the real models. A 3B model will not solve every multi-step task.
- Visual mode needs the all-sites permission (a Chrome restriction on screenshots).
- Pages inside cross-origin iframes are not scanned.
