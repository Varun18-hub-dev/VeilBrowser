import {
  SensitiveElementType,
  type DomScanResult,
  type ScannedElement,
} from '@veilbrowse/shared-types';
import { LocalMockAgent, runLocalAgentWorkflow } from '../content/mock-agent';

describe('Phase 8: Local Mock Agent Loop', () => {
  const syntheticSecrets = {
    email: 'sensitive.ceo@megacorp.internal',
    password: 'MasterPassword#2026',
    creditCard: '4111-5555-6666-7777',
  };

  const createMockElement = (
    id: string,
    tag: string,
    role: string,
    label: string,
    type: SensitiveElementType,
    isSensitive: boolean
  ): ScannedElement => ({
    elementId: id,
    tagName: tag,
    role,
    accessibleLabel: label,
    bounds: { x: 10, y: 10, width: 100, height: 40 },
    interactable: true,
    sensitivity: {
      isSensitive,
      type,
      confidence: isSensitive ? 0.95 : 0.0,
      sources: isSensitive ? ['type-attr'] : [],
      reasons: isSensitive ? [`detected ${type}`] : [],
    },
  });

  const domScanResult: DomScanResult = {
    pageUrl: 'https://example.com/preferences?user=secret_id_99',
    pageTitle: 'User Preferences',
    timestamp: Date.now(),
    elements: [
      createMockElement('vb-pwd', 'input', 'textbox', syntheticSecrets.password, SensitiveElementType.PASSWORD, true),
      createMockElement('vb-email', 'input', 'textbox', syntheticSecrets.email, SensitiveElementType.EMAIL, true),
      createMockElement('vb-cc', 'input', 'textbox', syntheticSecrets.creditCard, SensitiveElementType.PAYMENT, true),
      createMockElement('vb-notif-btn', 'button', 'button', 'Open Notification Settings', SensitiveElementType.NONE, false),
      createMockElement('vb-notif-toggle', 'input', 'checkbox', 'Email Notifications Toggle', SensitiveElementType.NONE, false),
    ],
    summary: { total: 5, sensitive: 3, byType: { password: 1, email: 1, payment: 1 } },
  };

  test('LocalMockAgent identifies itself explicitly and plans safe actions', () => {
    const agent = new LocalMockAgent();
    expect(agent.agentType).toBe('LOCAL MOCK AGENT — NOT LLM REASONING');
  });

  test('executes end-to-end local workflow for task: Open notification settings and enable email notifications', async () => {
    const clickMock = jest.fn();
    const domLookup = (id: string) => {
      return {
        id,
        click: clickMock,
      } as unknown as HTMLElement;
    };

    const task = 'Open notification settings and enable email notifications';
    const result = await runLocalAgentWorkflow(task, domScanResult, null, domLookup);

    // Verify task completion
    expect(result.completed).toBe(true);
    expect(result.plannedActions.length).toBeGreaterThanOrEqual(2);

    // Verify actions targeted safe controls, NEVER sensitive fields
    const targetedIds = result.plannedActions
      .map((a) => ('targetId' in a ? a.targetId : null))
      .filter(Boolean);

    expect(targetedIds).toContain('vb-notif-btn');
    expect(targetedIds).toContain('vb-notif-toggle');
    expect(targetedIds).not.toContain('vb-pwd');
    expect(targetedIds).not.toContain('vb-email');
    expect(targetedIds).not.toContain('vb-cc');

    // Verify execution results
    expect(clickMock).toHaveBeenCalled();
    expect(result.executionResults.length).toBe(result.plannedActions.length);

    // Verify PRIVACY INVARIANT in audit logs
    const serializedLogs = JSON.stringify(result.auditLogs);
    for (const secret of Object.values(syntheticSecrets)) {
      expect(serializedLogs).not.toContain(secret);
    }

    // Verify audit log has proper decision records
    expect(result.auditLogs[0].validationDecision).toBe('APPROVED');
    expect(result.auditLogs[0].executed).toBe(true);
  });
});
