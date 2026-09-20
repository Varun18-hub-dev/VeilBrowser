# VeilBrowse — Project Progression & Roadmap Document

## 1. Executive Summary

**Product**: VeilBrowse — Privacy Firewall for AI Browser Agents  
**Core Trust Boundary**: The browser operates as the local privacy enforcement layer; AWS operates strictly as the remote reasoning layer receiving only sanitized context.  
**Primary Invariant**: Raw sensitive DOM content, visual regions, and secret field values **must never** be transmitted outbound.

---

## 2. Phase-by-Phase Progression Tracker

| Phase | Description | Status | Key Deliverables & Milestones |
|---|---|---|---|
| **Phase 0** | Repository Inspection & Architecture Confirmation | **DONE** | Clean workspace verification, monorepo structure, strict boundary definitions |
| **Phase 1** | Synthetic Demo Site + Chrome Extension Skeleton | **DONE** | Chrome MV3 skeleton, DOM scanner, privacy invariants, synthetic portal, 19 tests passing |
| **Phase 2** | DOM Scanner & Semantic Element Representation | *Planned (Next)* | `MutationObserver` dynamic tracking, shadow DOM support, persistent veil-ID reconciliation |
| **Phase 3** | Local Sensitive-Data Detector | *Planned* | Extended pattern matching, contextual heuristics, local lightweight ML classifiers |
| **Phase 4** | Local Screenshot Capture | *Planned* | `chrome.tabs.captureVisibleTab`, viewport normalization, coordinate mapping |
| **Phase 5** | OCR / Lightweight Visual Perception | *Planned* | Browser-compatible local OCR (Wasm/WebGPU), text extraction for canvas & non-DOM elements |
| **Phase 6** | Detection Fusion + Confidence Engine | *Planned* | Multi-signal aggregation (DOM metadata + OCR + visual layout), fail-closed scoring |
| **Phase 7** | Redaction Engine | *Planned* | Pixel-level bounding box masking, blur/opaque fills, DOM value scrubbing |
| **Phase 8** | Sanitized Context Generator | *Planned* | Outbound payload builder (sanitized image + scrubbed DOM metadata tree) |
| **Phase 9** | Local Action Executor & Action Validation | *Planned* | Allowlisted action validation (`CLICK`, `SCROLL`, `WAIT`, `NAVIGATE`), target safety filter |
| **Phase 10** | Local Mock Reasoning Backend | *Planned* | Local simulator for AWS reasoning response before cloud deployment |
| **Phase 11** | AWS API Gateway + Lambda | *Planned* | Serverless endpoint, schema validation, rate-limiting, IAM roles |
| **Phase 12** | Amazon Bedrock Reasoning Integration | *Planned* | Claude 3 / Nova integration on Bedrock receiving sanitized input and emitting strict structured actions |
| **Phase 13** | DynamoDB + CloudWatch | *Planned* | Latency logging, privacy audit trails (metadata only), metric telemetry |
| **Phase 14** | Benchmarking and Evaluation | *Planned* | Automated evaluation suite measuring privacy score, accuracy, latency, memory/CPU |
| **Phase 15** | Security / Red-Team Testing | *Planned* | Adversarial prompt injection, coordinate mismatch exploits, data leakage fuzzing |
| **Phase 16** | Final Product Polish & Demo | *Planned* | End-to-end safe demo ("enable email notifications"), documentation, release packaging |

---

## 3. Phase 0 & Phase 1 Accomplishments in Detail

### A. Core Architecture Implemented
1. **Monorepo Structure (npm workspaces)**:
   - `@veilbrowse/shared-types`: Canonical type definitions across browser and cloud layers (`sensitivity.ts`, `dom.ts`, `messaging.ts`).
   - `@veilbrowse/extension`: Production-grade Chrome Manifest V3 extension authored in TypeScript and compiled with Webpack 5.
   - `@veilbrowse/demo-site`: Synthetic testing application with zero build overhead.
2. **Minimal Least-Privilege Permissions**:
   - Manifest V3 permissions restricted strictly to `http://localhost:3000/*` and `storage`. Broad matching patterns like `<all_urls>` are excluded.

### B. DOM Scanner & Classifier
1. **Dual Representation**:
   - Detects both interactive/safe elements (buttons, links, toggles) and sensitive elements (credentials, PII).
2. **Deterministic Stable Element IDs**:
   - Assigns sequential `data-veil-id="vb-N"` attributes, anchoring element identity to semantic nodes rather than fragile screen coordinates.
3. **Multi-Signal Classification Heuristics**:
   - Identifies 5 primary sensitive data categories:
     - `PASSWORD` (`type="password"`, `autocomplete="current-password"`, `passwd`)
     - `EMAIL` (`type="email"`, `autocomplete="email"`, keywords)
     - `PHONE` (`type="tel"`, `autocomplete="tel"`, keywords)
     - `ADDRESS` (`autocomplete="street-address"`, address keywords)
     - `IDENTITY` (`autocomplete="cc-number"`, `account_number` keywords)
4. **Visual Indicator Overlay**:
   - High-contrast category-specific outlines with label badges (e.g., `PASSWORD`, `EMAIL`, `IDENTITY`) on sensitive inputs.
   - Blue outlines for safe actionable controls.

### C. Privacy Invariant Proofs (Automated Tests)
- Total test count: **19 tests passing (100%)**.
- **Proof 1**: `ScannedElement` records possess no `.value` property at runtime.
- **Proof 2**: Form inputs' `accessibleLabel` reflects semantic `<label>` text only, never actual user input.
- **Proof 3**: Complete message pipeline serialization (`JSON.stringify(message)`) contains 0 occurrences of synthetic secret values:
  - `ajay.mehra@example.com` (0 occurrences)
  - `+91 98765 43210` (0 occurrences)
  - `VB-7729-AJAY-001` (0 occurrences)
  - `12/B Lotus Lane, Bandra West, Mumbai 400050` (0 occurrences)
  - `SuperSecretP@ssw0rd!123` (0 occurrences)
- **Proof 4**: Full URL sanitization strips all query parameters and hash fragments to prevent credential leakage in URL tokens.

---

## 4. Verification & Testing Matrix

| Component | Test File | Tests Run | Result | Evidence |
|---|---|---|---|---|
| Classifier Pure Logic | `apps/extension/src/__tests__/classifier.test.ts` | 12 | PASS | All rule-based heuristics, roles, and interactability tests passed |
| Privacy Invariants | `apps/extension/src/__tests__/privacy-invariants.test.ts` | 7 | PASS | Form values, credentials, and query tokens proven absent from serialized data |
| TypeScript Typechecking | `tsc --noEmit` | Workspace | PASS | 0 type errors across shared-types and extension |
| Extension Bundle Build | `webpack --config webpack.config.js` | 5 bundles | PASS | Built `content.js`, `background.js`, `popup.js`, `popup.html`, `manifest.json` |
| Demo Site HTTP Server | `http://localhost:3000` | E2E Endpoint | PASS | HTTP 200 OK, Content-Length: 8121 bytes |

---

## 5. Next Immediate Milestones: Phase 2

1. **Dynamic Page Observation**:
   - Integrate `MutationObserver` to automatically scan newly mounted DOM elements during SPA transitions.
2. **DOM Reconciliation**:
   - Ensure `data-veil-id` identifiers remain persistent across re-renders when elements are dynamically added or removed.
3. **Accessibility Tree Refinements**:
   - Expand `accessibleLabel` derivation to resolve complex multi-ID `aria-labelledby` chains and Shadow DOM boundaries.
