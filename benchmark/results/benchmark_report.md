# VeilBrowse Benchmark Report

**Generated:** 2026-09-20T14:51:40.752Z
**Environment:** Node v22.14.0 (win32)
**Scope:** 100% precision, recall, F1, and redaction coverage on the 23-case synthetic benchmark.
*Note: VeilBrowse does not claim 100% PII detection in general. Performance reflects the 23-case synthetic benchmark.*

---

## 1. Detection Performance (DOM + Visual)

| Metric | Measured Value |
|---|---|
| **Total Test Cases** | 23 |
| **True Positives (TP)** | 17 |
| **True Negatives (TN)** | 6 |
| **False Positives (FP)** | 0 |
| **False Negatives (FN)** | 0 |
| **Precision** | **100.00%** |
| **Recall** | **100.00%** |
| **F1 Score** | **100.00%** |

---

## 2. Redaction & Privacy Coverage

| Metric | Measured Value |
|---|---|
| **Total Sensitive Regions** | 13 |
| **Detected Sensitive Regions** | 17 |
| **Redacted Regions** | 13 |
| **Blocked Regions** | 0 |
| **Missed Regions** | 0 |
| **Redaction Coverage** | **100.00%** |

---

## 3. Latency & Resource Utilization

| Pipeline Component | Latency |
|---|---|
| DOM Classification Latency (per element) | 0.167 ms |
| Visual Scan Latency (per token) | 0.4 ms |
| Firewall Sanitization (Full Document) | 1 ms |
| End-to-End Local Agent Workflow | 1 ms |

| Resource Metric | Value |
|---|---|
| Heap Total | 204.57 MB |
| RSS | 250.58 MB |

---

## 4. Privacy Violations Verification

- **Total Evaluated Synthetic Secrets:** 18
- **Privacy Violations Detected:** **0**
- **Status:** **CLEAN**

*Zero synthetic secrets or sensitive query parameters escaped across the local privacy firewall boundary.*
