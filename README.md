# VeilBrowse — A Privacy Firewall for AI Browser Agents



VeilBrowse is a browser-native privacy firewall for AI browser agents. It ensures that sensitive DOM information, form values, credentials, and visual PII are detected, sanitized, and redacted **locally inside the browser** before any representation is exposed to an agent or remote reasoning service.

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
Reasoning Provider (LocalMockAgent / Future Bedrock or Ollama)
       ↓
Inbound AgentAction (CLICK / SCROLL / WAIT / NAVIGATE)
       ↓
Tier 1: Local Schema Validation
       ↓
Tier 2: Local Context & Sensitivity Validation
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
- Google Chrome or Chromium

### Install Dependencies
```bash
npm install
```

### Run All Extension & Security Tests (106 Tests)
```bash
npm run test:extension
```

### Run Reproducible Benchmark
```bash
npm run benchmark
```

### Typecheck & Build Extension
```bash
npm run typecheck:extension
npm run build:extension
```
Build output is generated in `apps/extension/dist`.

### Start the Synthetic Demo Site
```bash
npm run start:demo
```
Access at: `http://localhost:3000`
