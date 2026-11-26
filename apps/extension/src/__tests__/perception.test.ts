/**
 * @jest-environment jsdom
 */
import * as fs from 'fs';
import * as path from 'path';
import { SensitiveElementType, type DomScanResult, type ScannedElement } from '@veilbrowse/shared-types';
import { collectPageText, collectPageTextDetailed, redactKeyValue } from '../content/page-text';
import { guardTextBlocks, findPii } from '../content/outbound-guard';
import { validateAction, validateActionSchema, executeAction } from '../content/action-validator';
import { runPrivacyFirewall } from '../content/firewall';
import { buildVisualRequest, mapMarksToIds } from '../content/visual';

const DEMO = path.join(__dirname, '../../../demo-site/public');
function load(file: string): void {
  const html = fs.readFileSync(path.join(DEMO, file), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
  document.documentElement.innerHTML = html.replace(/^[\s\S]*?<html[^>]*>/i, '').replace(/<\/html>\s*$/i, '');
}
const PERSONAL = ['Ajay Kumar', 'ajay.kumar@example', '98450', 'Lotus Lane', '1MS24AI042'];

describe('page text reading (student portal)', () => {
  beforeAll(() => load('portal.html'));

  it('keeps the content needed to answer the task', () => {
    const text = collectPageText().join('\n');
    expect(text).toContain('Natural Language Processing | 38 | 26 | 68%');
    expect(text).toContain('Overall attendance: 82%');
    expect(text).toContain('Programme | B.Tech Artificial Intelligence & ML');
  });

  it('redacts personal values in key/value rows and greetings before anything is sent', () => {
    const guarded = guardTextBlocks(collectPageText(), 'pageText');
    const sent = guarded.blocks.join('\n');
    for (const p of PERSONAL) expect(sent).not.toContain(p);
    expect(sent).toContain('Name | [REDACTED]');
    expect(sent).toContain('USN | [REDACTED]');
    expect(sent).toContain('Welcome back, [NAME]');
  });
});

describe('page text reading (shop)', () => {
  beforeAll(() => {
    load('shop.html');
    // Results as the page script would render them.
    document.getElementById('results')!.innerHTML =
      '<div class="card"><div class="name">Nova Book 14</div><div class="price">₹58,990</div></div>' +
      '<div class="card"><div class="name">Lumen Air 13</div><div class="price">₹41,990</div></div>';
  });

  it('reads product names and prices from plain divs', () => {
    const text = collectPageText();
    expect(text).toEqual(expect.arrayContaining(['Nova Book 14', '₹58,990', 'Lumen Air 13', '₹41,990']));
  });

  it('hides the delivery details and the signed-in user', () => {
    const { blocks, redactedElements } = collectPageTextDetailed();
    const sent = guardTextBlocks(blocks, 'pageText').blocks.join('\n');
    for (const p of PERSONAL) expect(sent).not.toContain(p);
    expect(redactedElements.length).toBeGreaterThanOrEqual(3); // dd values get masked in screenshots too
    expect(sent.split('\n').every((b) => findPii(b).length === 0)).toBe(true);
  });
});

describe('inline key/value redaction', () => {
  it.each([
    ['Name: Ajay Kumar', 'Name: [REDACTED]'],
    ['Phone: 98450 12345 · Plan: Gold', 'Phone: [REDACTED] · Plan: Gold'],
    ['Order status: Shipped', 'Order status: Shipped'],
    ['Date of birth: 12/03/2004', 'Date of birth: [REDACTED]'],
  ])('%s', (input, expected) => {
    expect(redactKeyValue(input)).toBe(expected);
  });
});

function el(id: string, label: string, opts: Partial<ScannedElement> & { type?: SensitiveElementType } = {}): ScannedElement {
  const type = opts.type ?? SensitiveElementType.NONE;
  return {
    elementId: id,
    tagName: opts.tagName ?? 'input',
    role: opts.role ?? 'textbox',
    bounds: opts.bounds ?? { x: 10, y: 10, width: 200, height: 30 },
    sensitivity: { isSensitive: type !== SensitiveElementType.NONE, type, confidence: 1, sources: [], reasons: [] },
    interactable: true,
    accessibleLabel: label,
  } as ScannedElement;
}
function ctx(elements: ScannedElement[]) {
  const scan: DomScanResult = { pageUrl: 'https://shop.example/', pageTitle: 'Shop', timestamp: 0, summary: { total: elements.length, sensitive: 0, byType: {} as DomScanResult['summary']['byType'] }, elements };
  return runPrivacyFirewall(scan, null);
}

describe('TYPE action', () => {
  const page = ctx([
    el('search', 'Search products', { role: 'searchbox' }),
    el('comment', 'Order note'),
    el('email', 'Email', { type: SensitiveElementType.EMAIL }),
    el('pwd', 'Password', { type: SensitiveElementType.PASSWORD }),
    el('btn', 'Go', { tagName: 'button', role: 'button' }),
  ]);
  const type = (targetId: string, text: string, submit = false) => validateAction({ action: 'TYPE', targetId, text, submit }, page).decision;

  it('allows typing and submitting in a search box', () => expect(type('search', 'laptop', true)).toBe('APPROVED'));
  it('blocks typing into sensitive fields', () => {
    expect(type('email', 'x')).toBe('BLOCKED');
    expect(type('pwd', 'x')).toBe('BLOCKED');
  });
  it('blocks typing into non-text elements', () => expect(type('btn', 'x')).toBe('BLOCKED'));
  it('blocks typing redaction placeholders back into the page', () => expect(type('comment', 'Send to [EMAIL]')).toBe('BLOCKED'));
  it('asks the user before typing personal data or submitting a non-search form', () => {
    expect(type('comment', 'call me on 9845012345')).toBe('REQUIRES_CONFIRMATION');
    expect(type('comment', 'leave at door', true)).toBe('REQUIRES_CONFIRMATION');
    expect(type('comment', 'leave at door', false)).toBe('APPROVED');
  });
  it('rejects malformed TYPE actions at Tier 1', () => {
    expect(validateActionSchema({ action: 'TYPE', targetId: 'search' }).valid).toBe(false);
    expect(validateActionSchema({ action: 'TYPE', targetId: 'search', text: 'a'.repeat(501) }).valid).toBe(false);
  });

  it('sets the value through the native setter and submits the form', async () => {
    document.body.innerHTML = '<form id="f"><input id="s" type="search"></form>';
    const input = document.getElementById('s') as HTMLInputElement;
    const events: string[] = [];
    input.addEventListener('input', () => events.push('input'));
    const form = document.getElementById('f') as HTMLFormElement;
    form.requestSubmit = () => events.push('submit');
    const r = await executeAction({ action: 'TYPE', targetId: 'search', text: 'laptop', submit: true }, page, () => input);
    expect(r.success).toBe(true);
    expect(input.value).toBe('laptop');
    expect(events).toEqual(['input', 'submit']);
  });
});

describe('visual request', () => {
  it('masks sensitive fields, marks safe controls, and maps marks back to ids', () => {
    const page = ctx([
      el('search', 'Search products', { role: 'searchbox', bounds: { x: 100, y: 500, width: 300, height: 40 } }),
      el('card', 'Card number', { type: SensitiveElementType.PAYMENT, bounds: { x: 100, y: 600, width: 300, height: 40 } }),
      el('below', 'Footer link', { tagName: 'a', role: 'link', bounds: { x: 0, y: 5000, width: 50, height: 20 } }),
    ]);
    const { payload, markToId } = buildVisualRequest(page, 'find laptops', [], { x: 0, y: 400 }, { width: 1280, height: 720 });
    expect(payload.masks).toEqual([{ x: 96, y: 196, width: 308, height: 48 }]); // document -> viewport coords, padded
    expect(payload.marks).toEqual([{ n: 1, rect: { x: 100, y: 100, width: 300, height: 40 } }]); // off-screen link skipped
    expect(mapMarksToIds('Use the search box [1] at the top; box 7 is an ad.', markToId)).toBe('Use the search box [search] at the top; box 7 is an ad.');
  });
});

describe('bare keys in separate elements', () => {
  it('redacts the value after a "Name" label but not text after an ordinary heading', () => {
    document.body.innerHTML =
      '<div class="row"><div>Name</div><div>Ajay Kumar</div></div>' +
      '<h3>Contact us</h3><p>We reply within 2 working days.</p>' +
      '<div><span>Mobile number</span></div><div><span>98450 12345</span></div><div>Plan: Gold</div>';
    const sent = guardTextBlocks(collectPageText(), 'pageText').blocks.join('\n');
    expect(sent).not.toContain('Ajay Kumar');
    expect(sent).not.toContain('98450');
    expect(sent).toContain('We reply within 2 working days.');
    expect(sent).toContain('Plan: Gold');
  });
});
