import {
  SensitiveElementType,
  REDACTION_TOKENS,
  type ScannedElement,
  type DomScanResult,
} from '@veilbrowse/shared-types';
import {
  applyPrivacyPolicy,
  prepareSanitizedContext,
  sanitizeUrl,
} from '../content/redactor';

describe('Phase 4: Local Privacy Decision & Redaction Engine', () => {
  const mockBounds = { x: 10, y: 20, width: 100, height: 30 };

  const createMockElement = (
    id: string,
    type: SensitiveElementType,
    accessibleLabel: string,
    isSensitive: boolean
  ): ScannedElement => ({
    elementId: id,
    tagName: 'input',
    role: 'textbox',
    accessibleLabel,
    bounds: mockBounds,
    interactable: true,
    sensitivity: {
      isSensitive,
      type,
      confidence: 0.9,
      sources: ['type-attr'],
      reasons: ['mock reason'],
    },
  });

  describe('4.1 Policy Decisions and Redaction Tokens', () => {
    test('marks SAFE (NONE) element as ALLOWED', () => {
      const el = createMockElement('vb-1', SensitiveElementType.NONE, 'Search items', false);
      const policy = applyPrivacyPolicy(el);
      expect(policy.decision).toBe('ALLOWED');
      expect(policy.maskToken).toBeUndefined();
    });

    test('redacts PASSWORD with opaque mask token', () => {
      const el = createMockElement('vb-2', SensitiveElementType.PASSWORD, 'Enter your password', true);
      const policy = applyPrivacyPolicy(el);
      expect(policy.decision).toBe('REDACTED');
      expect(policy.maskToken).toBe(REDACTION_TOKENS[SensitiveElementType.PASSWORD]);
      expect(policy.maskToken).toBe('[REDACTED_PASSWORD]');
    });

    test('redacts EMAIL with specific token', () => {
      const el = createMockElement('vb-3', SensitiveElementType.EMAIL, 'Your Email', true);
      const policy = applyPrivacyPolicy(el);
      expect(policy.decision).toBe('REDACTED');
      expect(policy.maskToken).toBe('[REDACTED_EMAIL]');
    });

    test('redacts PHONE with specific token', () => {
      const el = createMockElement('vb-4', SensitiveElementType.PHONE, 'Mobile number', true);
      const policy = applyPrivacyPolicy(el);
      expect(policy.decision).toBe('REDACTED');
      expect(policy.maskToken).toBe('[REDACTED_PHONE]');
    });

    test('redacts IDENTITY with specific token', () => {
      const el = createMockElement('vb-5', SensitiveElementType.IDENTITY, 'SSN / Aadhaar', true);
      const policy = applyPrivacyPolicy(el);
      expect(policy.decision).toBe('REDACTED');
      expect(policy.maskToken).toBe('[REDACTED_ID]');
    });

    test('redacts ADDRESS with specific token', () => {
      const el = createMockElement('vb-6', SensitiveElementType.ADDRESS, 'Home Street', true);
      const policy = applyPrivacyPolicy(el);
      expect(policy.decision).toBe('REDACTED');
      expect(policy.maskToken).toBe('[REDACTED_ADDRESS]');
    });

    test('redacts PAYMENT with specific token', () => {
      const el = createMockElement('vb-7', SensitiveElementType.PAYMENT, 'Card Number', true);
      const policy = applyPrivacyPolicy(el);
      expect(policy.decision).toBe('REDACTED');
      expect(policy.maskToken).toBe('[REDACTED_PAYMENT]');
    });

    test('redacts UNKNOWN conservatively with fail-closed token', () => {
      const el = createMockElement('vb-8', SensitiveElementType.UNKNOWN, 'Ambiguous Field', true);
      const policy = applyPrivacyPolicy(el);
      expect(policy.decision).toBe('REDACTED');
      expect(policy.maskToken).toBe('[REDACTED_UNKNOWN]');
    });
  });

  describe('4.2 prepareSanitizedContext() Privacy Boundary', () => {
    const fakeSecretPayload = {
      userSecretPassword: 'SuperSecretPassword!99',
      userSecretEmail: 'alice.private@secretvault.corp',
      userSecretPhone: '+1-555-0199-837',
      userSecretSSN: '987-65-4321',
      userSecretCard: '4111-2222-3333-4444',
      userSecretAddress: '742 Evergreen Terrace, Springfield',
    };

    test('fails closed on null or invalid detector output', () => {
      const sanitized = prepareSanitizedContext(null);
      expect(sanitized.isFailClosed).toBe(true);
      expect(sanitized.elements).toHaveLength(0);
      expect(sanitized.redactionCoverage).toBe(1.0);
    });

    test('fails closed on undefined scanResult elements', () => {
      // @ts-expect-error intentionally testing malformed input
      const sanitized = prepareSanitizedContext({ pageUrl: 'https://example.com' });
      expect(sanitized.isFailClosed).toBe(true);
      expect(sanitized.elements).toHaveLength(0);
    });

    test('strips URL query parameters and fragments', () => {
      expect(sanitizeUrl('https://example.com/checkout?token=secret123&user=45#step2')).toBe(
        'https://example.com/checkout'
      );
    });

    test('ensures NO synthetic secrets leak into sanitized context serialization', () => {
      const mockElements: ScannedElement[] = [
        createMockElement('vb-10', SensitiveElementType.PASSWORD, fakeSecretPayload.userSecretPassword, true),
        createMockElement('vb-11', SensitiveElementType.EMAIL, fakeSecretPayload.userSecretEmail, true),
        createMockElement('vb-12', SensitiveElementType.PHONE, fakeSecretPayload.userSecretPhone, true),
        createMockElement('vb-13', SensitiveElementType.IDENTITY, fakeSecretPayload.userSecretSSN, true),
        createMockElement('vb-14', SensitiveElementType.ADDRESS, fakeSecretPayload.userSecretAddress, true),
        createMockElement('vb-15', SensitiveElementType.PAYMENT, fakeSecretPayload.userSecretCard, true),
        createMockElement('vb-16', SensitiveElementType.UNKNOWN, 'Custom Token Field', true),
        createMockElement('vb-17', SensitiveElementType.NONE, 'Help Search Box', false),
      ];

      const scanResult: DomScanResult = {
        pageUrl: 'https://example.com/account?session=secret_token_abc123#frag',
        pageTitle: 'Sensitive Vault',
        timestamp: 1710000000,
        elements: mockElements,
        summary: { total: 8, sensitive: 7, byType: {} },
      };

      const sanitized = prepareSanitizedContext(scanResult);
      const serialized = JSON.stringify(sanitized);

      // Verify zero leakage of each synthetic secret
      for (const secret of Object.values(fakeSecretPayload)) {
        expect(serialized).not.toContain(secret);
      }
      expect(serialized).not.toContain('secret_token_abc123');

      // Verify sanitized representation properties
      expect(sanitized.pageUrl).toBe('https://example.com/account');
      expect(sanitized.summary.allowed).toBe(1);
      expect(sanitized.summary.redacted).toBe(7);
      expect(sanitized.redactionCoverage).toBe(1.0);

      // Check allowed element properties strictly match schema
      const allowedEl = sanitized.elements.find((e) => e.elementId === 'vb-17');
      expect(allowedEl?.decision).toBe('ALLOWED');
      expect(allowedEl?.accessibleLabel).toBe('Help Search Box');
      expect(allowedEl).not.toHaveProperty('value');

      // Check redacted password element has masked token
      const pwdEl = sanitized.elements.find((e) => e.elementId === 'vb-10');
      expect(pwdEl?.decision).toBe('REDACTED');
      expect(pwdEl?.accessibleLabel).toBe('[REDACTED_PASSWORD]');
    });
  });
});
