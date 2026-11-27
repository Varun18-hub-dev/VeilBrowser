import { SensitiveElementType, type DomScanResult, type ScannedElement, type UnifiedSanitizedContext } from '@veilbrowse/shared-types';
import { runPrivacyFirewall } from '../content/firewall';
import { runAgentLoop, type AgentStep, type StepProvider, type StepRecord } from '../content/agent-loop';
import { guardOutboundContext, scrubText, countResidualPii } from '../content/outbound-guard';
import { isLikelyDestructiveLabel, validateAction, executeAction } from '../content/action-validator';
import { OllamaReasoningProvider } from '../content/ollama-provider';

function el(id: string, label: string, type: SensitiveElementType = SensitiveElementType.NONE, tagName = 'button'): ScannedElement {
  const sensitive = type !== SensitiveElementType.NONE;
  return {
    elementId: id,
    tagName,
    role: tagName === 'input' ? 'textbox' : 'button',
    bounds: { x: 10, y: 10, width: 100, height: 30 },
    sensitivity: { isSensitive: sensitive, type, confidence: sensitive ? 1 : 0, sources: [], reasons: [] },
    interactable: true,
    accessibleLabel: label,
  } as ScannedElement;
}

function scan(elements: ScannedElement[], title = 'Settings'): DomScanResult {
  return {
    pageUrl: 'https://example.com/settings',
    pageTitle: title,
    timestamp: Date.now(),
    summary: { total: elements.length, sensitive: 0, byType: {} as DomScanResult['summary']['byType'] },
    elements,
  };
}

/** Provider that replays a fixed script of steps and records what it was shown. */
class ScriptedProvider implements StepProvider {
  public readonly providerId = 'scripted';
  public seen: UnifiedSanitizedContext[] = [];
  constructor(private readonly script: AgentStep[]) {}
  async nextStep(_task: string, ctx: UnifiedSanitizedContext, history: StepRecord[]): Promise<AgentStep> {
    this.seen.push(ctx);
    return this.script[history.length] ?? { done: true, summary: 'script finished' };
  }
}

function deps(provider: StepProvider, elements: ScannedElement[], opts: { confirm?: boolean; clicks?: string[]; title?: string } = {}) {
  const clicks = opts.clicks ?? [];
  return {
    task: 'test task',
    provider,
    getContext: () => runPrivacyFirewall(scan(elements, opts.title), null),
    lookup: (id: string) => (elements.some((e) => e.elementId === id) ? ({ click: () => clicks.push(id) } as unknown as HTMLElement) : null),
    emit: () => undefined,
    confirm: async () => opts.confirm ?? false,
    settleMs: 0,
  };
}

describe('outbound PII guard', () => {
  it('masks personal data in visible text', () => {
    const r = scrubText('Signed in as rahul.k@example.com, call +91 98450 12345, card 4111 1111 1111 1111, PAN ABCDE1234F');
    expect(r.text).not.toMatch(/rahul|98450|4111|ABCDE/);
    expect(r.kinds).toEqual(expect.arrayContaining(['EMAIL', 'PHONE', 'CARD', 'PAN']));
  });

  it('does not flag ordinary labels or numbers that fail the card checksum', () => {
    expect(scrubText('Enable email notifications').kinds).toEqual([]);
    expect(scrubText('Order 1234 5678 9012 3456').kinds).not.toContain('CARD');
  });

  it('scrubs labels and title in the outbound context and leaves zero residual PII', () => {
    const ctx = runPrivacyFirewall(scan([el('a', 'Account: priya@example.com'), el('b', 'Save')], 'Inbox - priya@example.com'), null);
    const guarded = guardOutboundContext(ctx);
    expect(guarded.findings.length).toBe(2);
    expect(countResidualPii(guarded.context)).toBe(0);
    expect(JSON.stringify(guarded.context)).not.toContain('priya@example.com');
  });
});

describe('destructive-action detection does not trust the model', () => {
  it.each(['Delete account', 'Pay now', 'Place order', 'Transfer funds', 'Send'])('flags "%s"', (label) => {
    expect(isLikelyDestructiveLabel(label)).toBe(true);
  });
  it.each(['Notifications', 'Settings', 'Next page'])('does not flag "%s"', (label) => {
    expect(isLikelyDestructiveLabel(label)).toBe(false);
  });

  it('requires confirmation for a destructive label even when isDestructive is not set', () => {
    const ctx = runPrivacyFirewall(scan([el('del', 'Delete account')]), null);
    expect(validateAction({ action: 'CLICK', targetId: 'del' }, ctx).decision).toBe('REQUIRES_CONFIRMATION');
    expect(validateAction({ action: 'CLICK', targetId: 'del', confirmedByUser: true }, ctx).decision).toBe('APPROVED');
  });
});

describe('executeAction reports honestly', () => {
  it('fails when the target is no longer on the page', async () => {
    const ctx = runPrivacyFirewall(scan([el('x', 'Save')]), null);
    const r = await executeAction({ action: 'CLICK', targetId: 'x' }, ctx, () => null);
    expect(r.success).toBe(false);
  });
});

describe('agent loop', () => {
  const page = [el('notif', 'Notifications'), el('toggle', 'Email notifications'), el('pwd', 'Password', SensitiveElementType.PASSWORD, 'input'), el('del', 'Delete account')];

  it('runs several steps and reports the model summary', async () => {
    const clicks: string[] = [];
    const p = new ScriptedProvider([
      { done: false, action: { action: 'CLICK', targetId: 'notif' } },
      { done: false, action: { action: 'CLICK', targetId: 'toggle' } },
      { done: true, summary: 'Email notifications are on.' },
    ]);
    const r = await runAgentLoop(deps(p, page, { clicks }));
    expect(r.status).toBe('COMPLETED');
    expect(r.summary).toBe('Email notifications are on.');
    expect(clicks).toEqual(['notif', 'toggle']);
    expect(p.seen).toHaveLength(3); // re-observed the page each step
  });

  it('blocks a click on a password field', async () => {
    const clicks: string[] = [];
    const r = await runAgentLoop(deps(new ScriptedProvider([{ done: false, action: { action: 'CLICK', targetId: 'pwd' } }]), page, { clicks }));
    expect(r.status).toBe('BLOCKED');
    expect(clicks).toEqual([]);
  });

  it('rejects actions outside the closed schema', async () => {
    const r = await runAgentLoop(deps(new ScriptedProvider([{ done: false, action: { action: 'EXECUTE_JS', code: 'x' } }]), page));
    expect(r.status).toBe('BLOCKED');
    expect(r.steps[0].outcome).toBe('REJECTED');
  });

  it('stops when the user declines a destructive click', async () => {
    const clicks: string[] = [];
    const r = await runAgentLoop(deps(new ScriptedProvider([{ done: false, action: { action: 'CLICK', targetId: 'del' } }]), page, { clicks, confirm: false }));
    expect(r.status).toBe('STOPPED');
    expect(clicks).toEqual([]);
  });

  it('executes a destructive click only after approval', async () => {
    const clicks: string[] = [];
    const r = await runAgentLoop(deps(new ScriptedProvider([{ done: false, action: { action: 'CLICK', targetId: 'del' } }]), page, { clicks, confirm: true }));
    expect(clicks).toEqual(['del']);
    expect(r.status).toBe('COMPLETED');
  });

  it('never shows the provider personal data from visible text', async () => {
    const p = new ScriptedProvider([{ done: true, summary: 'ok' }]);
    const r = await runAgentLoop(deps(p, [el('me', 'Signed in as rahul@example.com'), ...page], { title: 'rahul@example.com - Inbox' }));
    expect(JSON.stringify(p.seen[0])).not.toContain('rahul@example.com');
    expect(r.piiMasked).toBe(2);
    expect(r.residualPii).toBe(0);
  });

  it('stops at the step limit', async () => {
    const forever: AgentStep[] = Array.from({ length: 20 }, () => ({ done: false, action: { action: 'WAIT', durationMs: 100 } }));
    const r = await runAgentLoop({ ...deps(new ScriptedProvider(forever), page), maxSteps: 4 });
    expect(r.status).toBe('STOPPED');
    expect(r.steps.length).toBeLessThanOrEqual(4);
  });

  it('reports provider errors without acting', async () => {
    const failing: StepProvider = { providerId: 'f', nextStep: async () => { throw new Error('model down'); } };
    const r = await runAgentLoop(deps(failing, page));
    expect(r.status).toBe('ERROR');
    expect(r.summary).toContain('model down');
  });
});

describe('Ollama provider', () => {
  it('parses actions and done replies', () => {
    expect(OllamaReasoningProvider.parseStep('{"action":"CLICK","targetId":"a"}')).toEqual({ done: false, action: { action: 'CLICK', targetId: 'a' } });
    expect(OllamaReasoningProvider.parseStep('{"done":true,"summary":"x"}')).toEqual({ done: true, summary: 'x' });
    expect(OllamaReasoningProvider.parseStep('{"actions":[{"action":"WAIT","durationMs":5}]}')).toEqual({ done: false, action: { action: 'WAIT', durationMs: 5 } });
    expect(() => OllamaReasoningProvider.parseStep('not json')).toThrow();
  });

  it('sends only sanitized context through the transport', async () => {
    let sent = '';
    const provider = new OllamaReasoningProvider({
      transport: async (_m, messages) => {
        sent = JSON.stringify(messages);
        return '{"done":true,"summary":"ok"}';
      },
    });
    const ctx = guardOutboundContext(runPrivacyFirewall(scan([el('e', 'Email', SensitiveElementType.EMAIL, 'input'), el('s', 'Signed in as a@b.co')]), null)).context;
    await provider.nextStep('t', ctx, []);
    expect(sent).not.toContain('a@b.co');
    expect(sent).toContain('Signed in as [EMAIL]');
  });
});

describe('toggle state', () => {
  it('is shown to the model for normal controls and hidden for sensitive ones', () => {
    const toggle = { ...el('t', 'Enable email notifications'), role: 'checkbox', state: { checked: true } } as ScannedElement;
    const secret = { ...el('s', 'I have a medical condition', SensitiveElementType.UNKNOWN), state: { checked: true } } as ScannedElement;
    const ctx = runPrivacyFirewall(scan([toggle, secret]), null);
    expect(ctx.elements.find((e) => e.elementId === 't')?.state).toEqual({ checked: true });
    expect(ctx.elements.find((e) => e.elementId === 's')?.state).toBeUndefined();
    const lines = new OllamaReasoningProvider({ transport: async () => '' }).formatElements(ctx);
    expect(lines).toContain('t | checkbox | "Enable email notifications" checked=true');
    expect(lines).toContain('1 private fields hidden');
    expect(lines).not.toContain('medical');
  });
});
