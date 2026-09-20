import {
  SensitiveElementType,
  type DomScanResult,
  type VisualScanResult,
  type ScannedElement,
  type VisualFinding,
} from '@veilbrowse/shared-types';
import { runPrivacyFirewall, calculateBoxOverlap } from '../content/firewall';

describe('Phase 6: Unified Privacy Firewall', () => {
  const mockDomElement = (
    id: string,
    type: SensitiveElementType,
    label: string,
    isSensitive: boolean,
    bounds = { x: 50, y: 100, width: 200, height: 40 }
  ): ScannedElement => ({
    elementId: id,
    tagName: 'input',
    role: 'textbox',
    accessibleLabel: label,
    bounds,
    interactable: true,
    sensitivity: {
      isSensitive,
      type,
      confidence: 0.9,
      sources: ['type-attr'],
      reasons: [`detected ${type}`],
    },
  });

  const mockVisualFinding = (
    id: string,
    category: SensitiveElementType,
    pageBoundingBox = { x: 50, y: 100, width: 200, height: 40 }
  ): VisualFinding => ({
    id,
    category,
    confidence: 0.95,
    boundingBox: pageBoundingBox,
    pageBoundingBox,
    reasons: [`visual OCR matched ${category}`],
    redacted: false,
  });

  test('calculateBoxOverlap computes spatial intersection correctly', () => {
    const box1 = { x: 0, y: 0, width: 100, height: 100 };
    const box2 = { x: 50, y: 50, width: 100, height: 100 };
    const overlap = calculateBoxOverlap(box1, box2);
    expect(overlap).toBeCloseTo(0.25, 2);

    const nonOverlapping = { x: 200, y: 200, width: 100, height: 100 };
    expect(calculateBoxOverlap(box1, nonOverlapping)).toBe(0.0);
  });

  test('combines DOM and visual scan findings with deduplication / correlation', () => {
    // Overlapping DOM and Visual finding for an email input
    const domEl = mockDomElement('vb-email', SensitiveElementType.EMAIL, 'Email Address', true);
    const visFinding = mockVisualFinding('vf-email', SensitiveElementType.EMAIL);

    // Additional standalone visual finding (e.g. text in an image banner)
    const bannerFinding = mockVisualFinding(
      'vf-banner',
      SensitiveElementType.IDENTITY,
      { x: 300, y: 500, width: 150, height: 30 }
    );

    const domScan: DomScanResult = {
      pageUrl: 'https://example.com/checkout?auth=secret123',
      pageTitle: 'Checkout Page',
      timestamp: Date.now(),
      elements: [domEl],
      summary: { total: 1, sensitive: 1, byType: { email: 1 } },
    };

    const visualScan: VisualScanResult = {
      timestamp: Date.now(),
      imageWidth: 1920,
      imageHeight: 1080,
      findings: [visFinding, bannerFinding],
      summary: { totalFindings: 2, sensitiveCount: 2, byCategory: { email: 1, identity: 1 } },
    };

    const result = runPrivacyFirewall(domScan, visualScan);

    expect(result.isFailClosed).toBe(false);
    expect(result.summary.totalSensitiveRegions).toBe(2);
    expect(result.summary.redactedCount).toBe(2);
    expect(result.redactionCoverage).toBe(1.0);

    // Correlated finding present
    const correlated = result.unifiedFindings.find((f) => f.source === 'correlated');
    expect(correlated).toBeDefined();
    expect(correlated?.category).toBe(SensitiveElementType.EMAIL);
    expect(correlated?.elementId).toBe('vb-email');

    // Standalone visual finding present
    const visualOnly = result.unifiedFindings.find((f) => f.source === 'visual');
    expect(visualOnly).toBeDefined();
    expect(visualOnly?.category).toBe(SensitiveElementType.IDENTITY);
  });

  test('fails closed when detector output is invalid or crashes', () => {
    // @ts-expect-error test malformed input
    const result = runPrivacyFirewall({ pageUrl: 'invalid' }, null);

    expect(result.isFailClosed).toBe(true);
    expect(result.elements).toHaveLength(0);
    expect(result.unifiedFindings).toHaveLength(0);
    expect(result.failureReason).toBeDefined();
  });

  test('PRIVACY INVARIANT: serialized output contains NO synthetic secrets', () => {
    const syntheticSecrets = {
      userSecretPassword: 'TestSyntheticPassword!2026',
      userSecretCard: '4111-2222-3333-4444',
      tokenParam: 'sensitive_jwt_token_9999',
    };

    const domElements: ScannedElement[] = [
      mockDomElement('vb-pwd', SensitiveElementType.PASSWORD, syntheticSecrets.userSecretPassword, true),
      mockDomElement('vb-card', SensitiveElementType.PAYMENT, syntheticSecrets.userSecretCard, true),
      mockDomElement('vb-btn', SensitiveElementType.NONE, 'Save Changes', false),
    ];

    const domScan: DomScanResult = {
      pageUrl: `https://example.com/vault?auth=${syntheticSecrets.tokenParam}`,
      pageTitle: 'Vault',
      timestamp: Date.now(),
      elements: domElements,
      summary: { total: 3, sensitive: 2, byType: {} },
    };

    const result = runPrivacyFirewall(domScan, null);
    const serialized = JSON.stringify(result);

    for (const secret of Object.values(syntheticSecrets)) {
      expect(serialized).not.toContain(secret);
    }

    expect(result.summary.allowedControls).toBe(1);
    expect(result.redactionCoverage).toBe(1.0);
  });
});
