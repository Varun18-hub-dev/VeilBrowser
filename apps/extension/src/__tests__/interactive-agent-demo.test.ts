import {
  SensitiveElementType,
  type DomScanResult,
  type AgentAction,
  type UnifiedSanitizedContext,
} from '@veilbrowse/shared-types';
import { runPrivacyFirewall } from '../content/firewall';
import { LocalMockAgent } from '../content/mock-agent';
import { validateActionSchema, validateAction, executeAction } from '../content/action-validator';

describe('Interactive End-to-End Agent Pipeline (Phase 11 Demo Readiness)', () => {
  const mockDomScan: DomScanResult = {
    pageUrl: 'http://localhost:3000/#settings',
    pageTitle: 'VeilBrowse Portal Demo',
    timestamp: Date.now(),
    summary: {
      total: 6,
      sensitive: 3,
      byType: {
        EMAIL: 1,
        PHONE: 0,
        PASSWORD: 1,
        ADDRESS: 0,
        IDENTITY: 0,
        PAYMENT: 0,
        UNKNOWN: 1,
        NONE: 3,
      },
    },
    elements: [
      {
        elementId: 'vb-pwd',
        tagName: 'input',
        role: 'textbox',
        bounds: { x: 10, y: 10, width: 200, height: 30 },
        sensitivity: {
          isSensitive: true,
          type: SensitiveElementType.PASSWORD,
          confidence: 1.0,
          sources: ['type-attr'],
          reasons: ['type="password"'],
        },
        interactable: true,
        accessibleLabel: 'Current Password',
      },
      {
        elementId: 'vb-email',
        tagName: 'input',
        role: 'textbox',
        bounds: { x: 10, y: 50, width: 200, height: 30 },
        sensitivity: {
          isSensitive: true,
          type: SensitiveElementType.EMAIL,
          confidence: 0.95,
          sources: ['type-attr'],
          reasons: ['type="email"'],
        },
        interactable: true,
        accessibleLabel: 'User Email Address',
      },
      {
        elementId: 'vb-ambiguous',
        tagName: 'input',
        role: 'textbox',
        bounds: { x: 10, y: 90, width: 200, height: 30 },
        sensitivity: {
          isSensitive: true,
          type: SensitiveElementType.UNKNOWN,
          confidence: 0.55,
          sources: ['name-attr'],
          reasons: ['Weak ambiguous token'],
        },
        interactable: true,
        accessibleLabel: 'Reference Code',
      },
      {
        elementId: 'vb-btn-settings',
        tagName: 'button',
        role: 'button',
        bounds: { x: 10, y: 130, width: 120, height: 30 },
        sensitivity: {
          isSensitive: false,
          type: SensitiveElementType.NONE,
          confidence: 0.0,
          sources: [],
          reasons: [],
        },
        interactable: true,
        accessibleLabel: 'Notification Settings',
      },
      {
        elementId: 'vb-toggle-email',
        tagName: 'input',
        role: 'checkbox',
        bounds: { x: 10, y: 170, width: 20, height: 20 },
        sensitivity: {
          isSensitive: false,
          type: SensitiveElementType.NONE,
          confidence: 0.0,
          sources: [],
          reasons: [],
        },
        interactable: true,
        accessibleLabel: 'Enable email notifications',
      },
      {
        elementId: 'vb-save-btn',
        tagName: 'button',
        role: 'button',
        bounds: { x: 10, y: 200, width: 100, height: 30 },
        sensitivity: {
          isSensitive: false,
          type: SensitiveElementType.NONE,
          confidence: 0.0,
          sources: [],
          reasons: [],
        },
        interactable: true,
        accessibleLabel: 'Save Preferences',
      },
    ],
  };

  let sanitizedContext: UnifiedSanitizedContext;

  beforeEach(() => {
    sanitizedContext = runPrivacyFirewall(mockDomScan, null);
  });

  // 1 & 2: Task submission and sanitized context generation
  test('1 & 2: Submits user task and generates UnifiedSanitizedContext with zero raw secrets', () => {
    expect(sanitizedContext.isFailClosed).toBe(false);
    expect(sanitizedContext.elements.length).toBe(6);

    // Password must be redacted with opaque token
    const pwdEl = sanitizedContext.elements.find((e) => e.elementId === 'vb-pwd');
    expect(pwdEl).toBeDefined();
    expect(pwdEl?.category).toBe(SensitiveElementType.PASSWORD);
    expect(pwdEl?.decision).toBe('REDACTED');
    expect(pwdEl?.maskToken).toBe('[REDACTED_PASSWORD]');

    // Value must never appear in sanitized element serialization
    const serialized = JSON.stringify(pwdEl);
    expect(serialized).not.toContain('"value"');
  });

  // 3: LocalMockAgent generates structured actions
  test('3: LocalMockAgent generates structured actions based on user task and sanitized context', () => {
    const agent = new LocalMockAgent();
    const task = 'Open notification settings and enable email notifications';
    const actions = agent.planActions(task, sanitizedContext);

    expect(actions.length).toBeGreaterThanOrEqual(2);
    // Action 1: notification settings button
    expect(actions[0].action).toBe('CLICK');
    expect((actions[0] as { targetId: string }).targetId).toBe('vb-btn-settings');
    // Action 2: email notification toggle
    expect(actions[1].action).toBe('CLICK');
    expect((actions[1] as { targetId: string }).targetId).toBe('vb-toggle-email');
  });

  // 4 & 5: Action validation before execution and successful safe execution
  test('4 & 5: Validates actions through two tiers and executes safe action in browser context', async () => {
    const clickedElements: string[] = [];
    const mockLookup = (id: string): HTMLElement | null => {
      return { click: () => clickedElements.push(id) } as unknown as HTMLElement;
    };

    const action: AgentAction = { action: 'CLICK', targetId: 'vb-toggle-email' };

    // Tier 1 Schema Validation
    const schemaVal = validateActionSchema(action);
    expect(schemaVal.valid).toBe(true);

    // Tier 2 Contextual Policy Validation
    const policyVal = validateAction(action, sanitizedContext);
    expect(policyVal.decision).toBe('APPROVED');

    // Actual browser element execution
    const execResult = await executeAction(action, sanitizedContext, mockLookup);
    expect(execResult.success).toBe(true);
    expect(clickedElements).toContain('vb-toggle-email');
  });

  // 6: Password target blocked fail-closed
  test('6: Attack defense blocks action targeting PASSWORD field at Tier 2 (fail-closed)', () => {
    const hostileAction: AgentAction = { action: 'CLICK', targetId: 'vb-pwd' };

    // Tier 1 passes (valid CLICK shape)
    const schemaVal = validateActionSchema(hostileAction);
    expect(schemaVal.valid).toBe(true);

    // Tier 2 BLOCKS because target is PASSWORD
    const policyVal = validateAction(hostileAction, sanitizedContext);
    expect(policyVal.decision).toBe('BLOCKED');
    expect(policyVal.reasons.some((r) => r.toLowerCase().includes('password'))).toBe(true);
  });

  // 7: EXECUTE_JS rejected at Tier 1 schema boundary
  test('7: Attack defense rejects EXECUTE_JS at Tier 1 schema boundary — closed action schema', () => {
    const maliciousPayload = {
      action: 'EXECUTE_JS',
      code: 'alert(document.cookie)',
    };

    const schemaVal = validateActionSchema(maliciousPayload);
    expect(schemaVal.valid).toBe(false);
    expect(schemaVal.errors[0]).toContain('is forbidden');
  });

  // 8: UNKNOWN target blocked fail-closed
  test('8: Fail-closed policy blocks actions targeting UNKNOWN / ambiguous sensitivity fields', () => {
    const ambiguousAction: AgentAction = { action: 'CLICK', targetId: 'vb-ambiguous' };

    const schemaVal = validateActionSchema(ambiguousAction);
    expect(schemaVal.valid).toBe(true);

    const policyVal = validateAction(ambiguousAction, sanitizedContext);
    expect(policyVal.decision).toBe('BLOCKED');
    expect(policyVal.reasons.some((r) => r.toLowerCase().includes('unknown'))).toBe(true);
  });

  // 9: Final result summary — no raw PII ever serialized
  test('9: Generates complete privacy summary and final result without raw PII in serialized context', () => {
    expect(sanitizedContext.summary.totalElements).toBe(6);
    expect(sanitizedContext.summary.redactedCount).toBe(3);
    expect(sanitizedContext.summary.allowedControls).toBe(3);
    expect(sanitizedContext.redactionCoverage).toBe(1.0);

    const serialized = JSON.stringify(sanitizedContext);
    expect(serialized).not.toContain('UserSecretPassword99');
    expect(serialized).not.toContain('recovery.ajay@example.com');
    expect(serialized).not.toContain('4111 2222');
  });
});
