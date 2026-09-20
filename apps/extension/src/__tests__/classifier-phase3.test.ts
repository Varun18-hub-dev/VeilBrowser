import {
  classifyElement,
  type ElementAttributes,
} from '../content/classifier';
import { SensitiveElementType } from '@veilbrowse/shared-types';

describe('Phase 3: Context-Aware Sensitivity Detector & Fail-Closed Policy', () => {
  describe('1. Payment Domain Detection', () => {
    test('classifies credit card number by name and payment placeholder pattern', () => {
      const attrs: ElementAttributes = {
        tagName: 'input',
        type: 'text',
        name: 'credit_card_number',
        placeholder: '4111 2222 3333 4444',
      };
      const result = classifyElement(attrs);
      expect(result.isSensitive).toBe(true);
      expect(result.type).toBe(SensitiveElementType.PAYMENT);
      expect(result.sources).toContain('name-attr');
      expect(result.sources).toContain('pattern');
      expect(result.reasons.length).toBeGreaterThanOrEqual(2);
    });

    test('classifies card CVV security code by name and pattern', () => {
      const attrs: ElementAttributes = {
        tagName: 'input',
        type: 'password',
        name: 'card_cvv',
        placeholder: 'CVC',
      };
      const result = classifyElement(attrs);
      expect(result.isSensitive).toBe(true);
      // type="password" is high confidence, but payment keywords and CVC pattern match payment
      expect([SensitiveElementType.PASSWORD, SensitiveElementType.PAYMENT]).toContain(result.type);
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    });

    test('classifies autocomplete="cc-exp" as PAYMENT', () => {
      const attrs: ElementAttributes = {
        tagName: 'input',
        type: 'text',
        autocomplete: 'cc-exp',
      };
      const result = classifyElement(attrs);
      expect(result.isSensitive).toBe(true);
      expect(result.type).toBe(SensitiveElementType.PAYMENT);
      expect(result.sources).toContain('autocomplete');
    });
  });

  describe('2. Context-Aware Structural Heading Reinforcement', () => {
    test('section heading boosts ambiguous field to PAYMENT', () => {
      const attrs: ElementAttributes = {
        tagName: 'input',
        type: 'text',
        labelText: 'Cardholder Name',
        contextHeading: 'Payment & Billing Information',
      };
      const result = classifyElement(attrs);
      expect(result.isSensitive).toBe(true);
      expect(result.type).toBe(SensitiveElementType.PAYMENT);
      expect(result.sources).toContain('context-heading');
      expect(result.sources).toContain('label-text');
      expect(result.confidence).toBeGreaterThan(0.75); // Multi-signal boost applied
    });

    test('identity verification heading reinforces government ID detection', () => {
      const attrs: ElementAttributes = {
        tagName: 'input',
        type: 'text',
        name: 'govt_id',
        labelText: 'Identification Number',
        contextHeading: 'Identity Verification & KYC Portal',
      };
      const result = classifyElement(attrs);
      expect(result.isSensitive).toBe(true);
      expect(result.type).toBe(SensitiveElementType.IDENTITY);
      expect(result.sources).toContain('context-heading');
      expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    });
  });

  describe('3. Multi-Signal Evidence Accumulation', () => {
    test('three corroborating signals increase confidence deterministically', () => {
      const singleSignalAttrs: ElementAttributes = {
        tagName: 'input',
        type: 'text',
        name: 'contact_number',
      };
      const singleResult = classifyElement(singleSignalAttrs);

      const multiSignalAttrs: ElementAttributes = {
        tagName: 'input',
        type: 'text',
        name: 'contact_number',
        labelText: 'Emergency Contact Mobile Number',
        contextHeading: 'Personal Communication & Phone Details',
      };
      const multiResult = classifyElement(multiSignalAttrs);

      expect(multiResult.type).toBe(SensitiveElementType.PHONE);
      expect(multiResult.confidence).toBeGreaterThan(singleResult.confidence);
      expect(multiResult.reasons.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('4. International Format Pattern Heuristics (Metadata Only)', () => {
    test('detects international phone pattern in placeholder without reading .value', () => {
      const attrs: ElementAttributes = {
        tagName: 'input',
        type: 'text',
        placeholder: '+91 98765-43210',
      };
      const result = classifyElement(attrs);
      expect(result.isSensitive).toBe(true);
      expect(result.type).toBe(SensitiveElementType.PHONE);
      expect(result.sources).toContain('pattern');
    });

    test('detects email placeholder pattern in metadata', () => {
      const attrs: ElementAttributes = {
        tagName: 'input',
        type: 'text',
        placeholder: 'ajay.mehra@company.org',
      };
      const result = classifyElement(attrs);
      expect(result.isSensitive).toBe(true);
      expect(result.type).toBe(SensitiveElementType.EMAIL);
      expect(result.sources).toContain('pattern');
    });
  });

  describe('5. Fail-Closed Policy: Ambiguous Fields -> UNKNOWN', () => {
    test('weak borderline signal without corroboration fails closed to UNKNOWN', () => {
      const attrs: ElementAttributes = {
        tagName: 'input',
        type: 'text',
        placeholder: 'suite', // weak address keyword, alone in generic input
      };
      const result = classifyElement(attrs);
      expect(result.isSensitive).toBe(true); // Fail-closed: treated as sensitive
      expect(result.type).toBe(SensitiveElementType.UNKNOWN);
      expect(result.reasons[0]).toContain('fail-closed to UNKNOWN');
    });

    test('conflicting signals between different categories fail closed to UNKNOWN', () => {
      const attrs: ElementAttributes = {
        tagName: 'input',
        type: 'text',
        name: 'user_phone', // phone signal 0.75
        labelText: 'Billing Street Address', // address signal 0.75
      };
      const result = classifyElement(attrs);
      expect(result.isSensitive).toBe(true);
      expect(result.type).toBe(SensitiveElementType.UNKNOWN);
      expect(result.reasons[0]).toContain('Conflicting evidence');
    });
  });

  describe('6. Safe Fields Remain SAFE (NONE)', () => {
    test('explicit type="search" is classified as SAFE (NONE)', () => {
      const attrs: ElementAttributes = {
        tagName: 'input',
        type: 'search',
        name: 'q',
        placeholder: 'Search documentation...',
      };
      const result = classifyElement(attrs);
      expect(result.isSensitive).toBe(false);
      expect(result.type).toBe(SensitiveElementType.NONE);
      expect(result.confidence).toBe(0);
    });

    test('safe keywords (comment, quantity, feedback) are classified as SAFE (NONE)', () => {
      const attrs: ElementAttributes = {
        tagName: 'textarea',
        name: 'user_feedback',
        labelText: 'Public Feedback Comments',
      };
      const result = classifyElement(attrs);
      expect(result.isSensitive).toBe(false);
      expect(result.type).toBe(SensitiveElementType.NONE);
    });
  });

  describe('7. Unusual Naming Variations', () => {
    test('correctly handles unusual field naming conventions', () => {
      expect(classifyElement({ tagName: 'input', name: 'user_mail' }).type).toBe(SensitiveElementType.EMAIL);
      expect(classifyElement({ tagName: 'input', name: 'contactNumber' }).type).toBe(SensitiveElementType.PHONE);
      expect(classifyElement({ tagName: 'input', name: 'govt_id' }).type).toBe(SensitiveElementType.IDENTITY);
      expect(classifyElement({ tagName: 'input', name: 'billingAddress' }).type).toBe(SensitiveElementType.ADDRESS);
      expect(classifyElement({ tagName: 'input', name: 'pwd' }).type).toBe(SensitiveElementType.PASSWORD);
      expect(classifyElement({ tagName: 'input', name: 'mobile_no' }).type).toBe(SensitiveElementType.PHONE);
    });
  });

  describe('8. Explainability & Privacy Invariants in Reasons', () => {
    test('classification reasons explain decision without containing user secrets', () => {
      const secretMockEmail = 'super_confidential_secret@target.internal';
      const attrs: ElementAttributes = {
        tagName: 'input',
        type: 'text',
        name: 'recovery_email',
        labelText: 'Account Recovery Email Address',
        contextHeading: 'Security Configuration',
      };

      const result = classifyElement(attrs);
      expect(result.reasons).toBeDefined();
      expect(result.reasons.length).toBeGreaterThan(0);

      const serializedReasons = JSON.stringify(result.reasons);
      expect(serializedReasons).not.toContain(secretMockEmail);
      expect(serializedReasons).toContain('name attribute');
      expect(serializedReasons).toContain('label text');
    });
  });
});
