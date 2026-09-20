import {
  SensitiveElementType,
  generateRequestId,
  generateSessionId,
  createOutboundAgentRequest,
  type OutboundAgentRequest,
  type ReasoningProvider,
  type UnifiedSanitizedContext,
  type AgentAction,
} from '@veilbrowse/shared-types';
import {
  validateActionSchema,
  validateAction,
} from '../content/action-validator';
import { LocalMockAgent } from '../content/mock-agent';
import { runPrivacyFirewall } from '../content/firewall';

describe('Pre-AWS Integration Hardening Suite', () => {
  const syntheticSecrets = {
    userSecretEmail: 'alice.private@secretvault.corp',
    userSecretPassword: 'SuperSecretPassword!99',
    userSecretToken: 'jwt_secret_token_abc123',
    userSecretSSN: '987-65-4321',
  };

  const mockContext: UnifiedSanitizedContext = runPrivacyFirewall({
    pageUrl: `https://example.com/account?token=${syntheticSecrets.userSecretToken}`,
    pageTitle: 'Account Settings',
    timestamp: Date.now(),
    elements: [
      {
        elementId: 'vb-pwd',
        tagName: 'input',
        role: 'textbox',
        accessibleLabel: syntheticSecrets.userSecretPassword,
        bounds: { x: 10, y: 10, width: 100, height: 30 },
        interactable: true,
        sensitivity: {
          isSensitive: true,
          type: SensitiveElementType.PASSWORD,
          confidence: 1.0,
          sources: ['type-attr'],
          reasons: ['type=password'],
        },
      },
      {
        elementId: 'vb-btn-safe',
        tagName: 'button',
        role: 'button',
        accessibleLabel: 'Save Notification Preferences',
        bounds: { x: 10, y: 50, width: 100, height: 30 },
        interactable: true,
        sensitivity: {
          isSensitive: false,
          type: SensitiveElementType.NONE,
          confidence: 0.0,
          sources: [],
          reasons: [],
        },
      },
    ],
    summary: { total: 2, sensitive: 1, byType: { password: 1 } },
  });

  // 1. Request / Session Identifiers
  describe('1. Request and Session Identifiers', () => {
    test('generates opaque, random request and session IDs with correct prefixes', () => {
      const req1 = generateRequestId();
      const req2 = generateRequestId();
      const ses1 = generateSessionId();
      const ses2 = generateSessionId();

      expect(req1).toMatch(/^req-[0-9a-fA-F-]+$/);
      expect(req2).toMatch(/^req-[0-9a-fA-F-]+$/);
      expect(ses1).toMatch(/^ses-[0-9a-fA-F-]+$/);
      expect(ses2).toMatch(/^ses-[0-9a-fA-F-]+$/);

      // Must be distinct
      expect(req1).not.toBe(req2);
      expect(ses1).not.toBe(ses2);

      // Must NOT contain user data
      for (const secret of Object.values(syntheticSecrets)) {
        expect(req1).not.toContain(secret);
        expect(ses1).not.toContain(secret);
      }
    });
  });

  // 2. Outbound Request Envelope & Zero Secret Leakage
  describe('2. Frozen Outbound Contract (OutboundAgentRequest)', () => {
    test('builds outbound request envelope without leaking secrets or URL tokens', () => {
      const task = 'Open notification settings and enable email notifications';
      const outbound: OutboundAgentRequest = createOutboundAgentRequest({
        task,
        context: mockContext,
      });

      expect(outbound.requestId).toBeDefined();
      expect(outbound.sessionId).toBeDefined();
      expect(outbound.task).toBe(task);
      expect(outbound.context).toBe(mockContext);

      // Verify serialization does not leak any secret
      const serialized = JSON.stringify(outbound);
      for (const secret of Object.values(syntheticSecrets)) {
        expect(serialized).not.toContain(secret);
      }

      // Context must be sanitized
      expect(outbound.context.pageUrl).toBe('https://example.com/account');
      expect(outbound.context.elements.find((e) => e.elementId === 'vb-pwd')?.accessibleLabel).toBe(
        '[REDACTED_PASSWORD]'
      );
    });
  });

  // 3. Inbound Action Schema Validation (Tier 1)
  describe('3. Frozen Inbound Action Contract (AgentAction)', () => {
    test('validateActionSchema accepts valid CLICK action', () => {
      const res = validateActionSchema({ action: 'CLICK', targetId: 'vb-btn-safe' });
      expect(res.valid).toBe(true);
      expect(res.action?.action).toBe('CLICK');
      expect(res.errors).toHaveLength(0);
    });

    test('validateActionSchema accepts valid CLICK with coordinates', () => {
      const res = validateActionSchema({ action: 'CLICK', targetCoordinates: { x: 50, y: 60 } });
      expect(res.valid).toBe(true);
      expect(res.action?.action).toBe('CLICK');
    });

    test('validateActionSchema accepts valid SCROLL, WAIT, NAVIGATE', () => {
      expect(validateActionSchema({ action: 'SCROLL', direction: 'down', distance: 400 }).valid).toBe(true);
      expect(validateActionSchema({ action: 'WAIT', durationMs: 1000 }).valid).toBe(true);
      expect(validateActionSchema({ action: 'NAVIGATE', url: 'https://example.com/settings' }).valid).toBe(true);
    });

    test('validateActionSchema REJECTS forbidden actions (EXECUTE_JS, EVAL)', () => {
      const resJs = validateActionSchema({ action: 'EXECUTE_JS', code: 'alert(1)' });
      expect(resJs.valid).toBe(false);
      expect(resJs.errors[0]).toContain('forbidden');

      const resEval = validateActionSchema({ action: 'EVAL', code: '1+1' });
      expect(resEval.valid).toBe(false);
      expect(resEval.errors[0]).toContain('forbidden');
    });

    test('validateActionSchema REJECTS malformed click, scroll, and wait payloads', () => {
      // Click without targetId or coords
      expect(validateActionSchema({ action: 'CLICK' }).valid).toBe(false);
      // Click with NaN coords
      expect(validateActionSchema({ action: 'CLICK', targetCoordinates: { x: 'abc', y: 50 } }).valid).toBe(false);
      // Scroll with invalid direction
      expect(validateActionSchema({ action: 'SCROLL', direction: 'sideways' }).valid).toBe(false);
      // Wait with negative duration
      expect(validateActionSchema({ action: 'WAIT', durationMs: -50 }).valid).toBe(false);
      // Navigate with empty url
      expect(validateActionSchema({ action: 'NAVIGATE', url: '   ' }).valid).toBe(false);
      // Non-object
      expect(validateActionSchema('not an object').valid).toBe(false);
    });

    test('validateAction rejects at schema tier before safety evaluation', () => {
      const result = validateAction({ action: 'MALICIOUS_CMD' }, mockContext);
      expect(result.valid).toBe(false);
      expect(result.decision).toBe('REJECTED');
      expect(result.reasons[0]).toContain('forbidden');
    });
  });

  // 4. ReasoningProvider Abstraction
  describe('4. ReasoningProvider Abstraction & Mock Agent Compatibility', () => {
    test('LocalMockAgent implements ReasoningProvider interface', async () => {
      const provider: ReasoningProvider = new LocalMockAgent();

      expect(provider.providerId).toBe('local-mock-agent');

      const task = 'Open notification settings';
      const action: AgentAction = await provider.generateAction(task, mockContext);

      expect(action).toBeDefined();
      expect(action.action).toBe('CLICK');
      if (action.action === 'CLICK') {
        expect(action.targetId).toBe('vb-btn-safe');
      }

      // Validate that the generated action passes the local action validator
      const validation = validateAction(action, mockContext);
      expect(validation.valid).toBe(true);
      expect(validation.decision).toBe('APPROVED');
    });
  });
});
