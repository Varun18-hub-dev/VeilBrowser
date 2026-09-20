import * as fs from 'fs';
import * as path from 'path';
import { runBenchmark } from '../../../../benchmark/harness';

describe('Phase 10: Reproducible Privacy & Performance Benchmark', () => {
  test('executes benchmark harness and validates detection, redaction, and zero privacy violations', () => {
    const report = runBenchmark();

    // 1. Detection Performance
    expect(report.detectionMetrics.precision).toBeGreaterThanOrEqual(0.9);
    expect(report.detectionMetrics.recall).toBeGreaterThanOrEqual(0.9);
    expect(report.detectionMetrics.f1Score).toBeGreaterThanOrEqual(0.9);

    // 2. Redaction & Privacy Coverage
    expect(report.redactionMetrics.redactionCoverage).toBe(1.0);
    expect(report.redactionMetrics.missedRegions).toBe(0);

    // 3. ZERO Privacy Violations
    expect(report.privacyViolations.violationsDetected).toBe(0);
    expect(report.privacyViolations.status).toBe('CLEAN');

    // 4. Report Artifacts Written to Disk
    const resultsDir = path.resolve(__dirname, '../../../../benchmark/results');
    expect(fs.existsSync(path.join(resultsDir, 'benchmark_report.json'))).toBe(true);
    expect(fs.existsSync(path.join(resultsDir, 'benchmark_report.md'))).toBe(true);

    const jsonContent = fs.readFileSync(path.join(resultsDir, 'benchmark_report.json'), 'utf-8');
    const parsed = JSON.parse(jsonContent);
    expect(parsed.privacyViolations.status).toBe('CLEAN');
    expect(parsed.privacyViolations.violationsDetected).toBe(0);
  });
});
