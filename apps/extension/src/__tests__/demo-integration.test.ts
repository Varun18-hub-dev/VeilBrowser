import {
  SensitiveElementType,
  type DomScanResult,
  type ScannedElement,
  type VisualScanResult,
} from '@veilbrowse/shared-types';
import { runPrivacyFirewall } from '../content/firewall';
import { validateAction } from '../content/action-validator';
import { runLocalAgentWorkflow } from '../content/mock-agent';

describe('Phase 11: Final Local Demo Integration & End-to-End Privacy Verification', () => {
  const demoRawSecrets = {
    fullname: 'Ajay Mehra',
    email: 'ajay.mehra@example.com',
    phone: '+91 98765 43210',
    address: '12/B Lotus Lane, Bandra West, Mumbai 400050',
    password: 'UserSecretPassword99!',
    cardNumber: '4111 2222 3333 4444',
    cvv: '123',
    tokenParam: 'secret_auth_token_xyz88',
  };

  const createScannedInput = (
    id: string,
    label: string,
    category: SensitiveElementType,
    interactable = true
  ): ScannedElement => ({
    elementId: id,
    tagName: 'input',
    role: 'textbox',
    accessibleLabel: label,
    bounds: { x: 50, y: 50, width: 200, height: 40 },
    interactable,
    sensitivity: {
      isSensitive: category !== SensitiveElementType.NONE,
      type: category,
      confidence: 0.95,
      sources: ['name-attr'],
      reasons: [`classified as ${category}`],
    },
  });

  const demoDomScan: DomScanResult = {
    pageUrl: `https://novaportal.example.com/account?token=${demoRawSecrets.tokenParam}#step2`,
    pageTitle: 'Account Settings',
    timestamp: Date.now(),
    elements: [
      createScannedInput('vb-email', demoRawSecrets.email, SensitiveElementType.EMAIL),
      createScannedInput('vb-phone', demoRawSecrets.phone, SensitiveElementType.PHONE),
      createScannedInput('vb-addr', demoRawSecrets.address, SensitiveElementType.ADDRESS),
      createScannedInput('vb-pwd', demoRawSecrets.password, SensitiveElementType.PASSWORD),
      createScannedInput('vb-card', demoRawSecrets.cardNumber, SensitiveElementType.PAYMENT),
      createScannedInput('vb-ambiguous', 'Reference Code', SensitiveElementType.UNKNOWN),
      {
        elementId: 'vb-notif-btn',
        tagName: 'button',
        role: 'button',
        accessibleLabel: 'Save Notification Preferences',
        bounds: { x: 50, y: 300, width: 150, height: 40 },
        interactable: true,
        sensitivity: {
          isSensitive: false,
          type: SensitiveElementType.NONE,
          confidence: 0.0,
          sources: [],
          reasons: [],
        },
      },
      {
        elementId: 'vb-notif-toggle',
        tagName: 'input',
        role: 'checkbox',
        accessibleLabel: 'Enable email notifications',
        bounds: { x: 50, y: 350, width: 20, height: 20 },
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
    summary: { total: 8, sensitive: 6, byType: {} },
  };

  const demoVisualScan: VisualScanResult = {
    timestamp: Date.now(),
    imageWidth: 400,
    imageHeight: 220,
    findings: [
      {
        id: 'vf-card',
        category: SensitiveElementType.PAYMENT,
        confidence: 0.95,
        boundingBox: { x: 30, y: 110, width: 250, height: 30 },
        pageBoundingBox: { x: 30, y: 110, width: 250, height: 30 },
        reasons: ['visual card text pattern'],
        redacted: true,
      },
    ],
    summary: { totalFindings: 1, sensitiveCount: 1, byCategory: { payment: 1 } },
  };

  test('executes complete 11-step demo verification flow', async () => {
    // 1-5. Local DOM + Visual perception & Privacy Firewall
    const sanitizedContext = runPrivacyFirewall(demoDomScan, demoVisualScan);
    const serializedOutbound = JSON.stringify(sanitizedContext);

    // 6. Sanitized Context Invariants: zero secrets leak
    for (const secret of Object.values(demoRawSecrets)) {
      expect(serializedOutbound).not.toContain(secret);
    }
    expect(sanitizedContext.redactionCoverage).toBe(1.0);

    // 7-9. Mock Agent Workflow: Safe action execution
    const clickMock = jest.fn();
    const domLookup = (id: string) => ({ id, click: clickMock } as unknown as HTMLElement);

    const taskResult = await runLocalAgentWorkflow(
      'Open notification settings and enable email notifications',
      demoDomScan,
      demoVisualScan,
      domLookup
    );

    expect(taskResult.completed).toBe(true);
    expect(clickMock).toHaveBeenCalled();

    // 10. Sensitive action BLOCKED
    const sensitiveClick = validateAction({ action: 'CLICK', targetId: 'vb-pwd' }, sanitizedContext);
    expect(sensitiveClick.valid).toBe(false);
    expect(sensitiveClick.decision).toBe('BLOCKED');

    // 11. Unknown action BLOCKED
    const unknownClick = validateAction({ action: 'CLICK', targetId: 'vb-ambiguous' }, sanitizedContext);
    expect(unknownClick.valid).toBe(false);
    expect(unknownClick.decision).toBe('BLOCKED');

    // 12. Arbitrary JS attack REJECTED
    const jsAttack = validateAction({ action: 'EXECUTE_JS', code: 'alert(1)' }, sanitizedContext);
    expect(jsAttack.valid).toBe(false);
    expect(jsAttack.decision).toBe('REJECTED');
  });
});
