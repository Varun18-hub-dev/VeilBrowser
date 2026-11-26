import { VEILBROWSE_INTERNAL_ATTR } from './scanner';
import { findPii } from './outbound-guard';

/**
 * Privacy-safe reading of the page's visible text.
 *
 * The agent needs to read content to answer questions ("what is my attendance?",
 * "which laptop is cheapest?"). This module collects visible text blocks and redacts
 * personal values BEFORE anything else sees them:
 *
 *  - key/value text:      "Name: Ajay Kumar"          -> "Name: [REDACTED]"
 *  - definition lists:    <dt>Email</dt><dd>a@b.c</dd> -> "Email: [REDACTED]"
 *  - table rows:          | Phone | 98450 12345 |      -> "Phone | [REDACTED]"
 *  - label + value pairs: <span>Address</span><span>12 Lotus Lane</span>
 *
 * Pattern-based PII (emails, phones, cards...) and greeting names ("Signed in as X")
 * are removed afterwards by the outbound guard. Text inside form fields is never read.
 */

/** Keys whose values are personal data. Matched against the key text of a key/value pair. */
const SENSITIVE_KEY =
  /\b(name|full name|first name|last name|surname|user ?name|login|e-?mail|mail|phone|mobile|tel|telephone|contact|address|street|city|pin ?code|zip|postal|dob|date of birth|birth ?date|age|gender|account(?: no| number| id)?|acct|iban|ifsc|card|cvv|expiry|aadhaar|aadhar|pan|passport|ssn|national id|voter id|licen[cs]e|password|passcode|pin|otp|salary|income|balance|usn|roll ?no|roll number|reg(?:istration)? ?no|student id|employee id|emp id|parent|guardian|father|mother|spouse)\b/i;

const BLOCK_SELECTOR =
  'h1,h2,h3,h4,h5,h6,p,li,dt,dd,caption,figcaption,blockquote,summary,legend,[role="heading"],[role="status"],[role="alert"]';
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'BUTTON', 'A']);

export const REDACTED = '[REDACTED]';

/** A standalone key such as "Name", "Email:" or "Mobile number" (the value is in the next element). */
const BARE_KEY = new RegExp(
  '^\\s*(?:your\\s+|registered\\s+|primary\\s+)?' + SENSITIVE_KEY.source + '(?:\\s+(?:number|no\\.?|id|address))?\\s*[:：*]?\\s*$',
  'i'
);
export interface PageTextOptions {
  maxBlocks?: number;
  maxBlockChars?: number;
  maxTotalChars?: number;
}

export function isSensitiveKey(key: string): boolean {
  const k = key.trim().replace(/[:：*]+$/, '').trim();
  return k.length > 0 && k.length <= 40 && SENSITIVE_KEY.test(k);
}

/** "Name: Ajay Kumar" -> "Name: [REDACTED]"; text without a sensitive key is unchanged. */
export function redactKeyValue(text: string): string {
  // Several pairs on one line: "Name: A · Email: b"
  return text.replace(/([A-Za-z][A-Za-z .'/()-]{0,38}?)\s*[:：]\s*([^:：|·•\n]+?)(?=\s*(?:[|·•\n]|$|\s[A-Z][A-Za-z .'/()-]{0,38}?\s*[:：]))/g, (m, key: string) =>
    isSensitiveKey(key) ? `${key.trim()}: ${REDACTED}` : m
  );
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function isVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return true;
  if (el.closest(`[${VEILBROWSE_INTERNAL_ATTR}]`)) return false;
  if (el.closest('[aria-hidden="true"],[hidden]')) return false;
  if (typeof window.getComputedStyle === 'function') {
    const cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
  }
  return true;
}

/** Text of an element without form controls, buttons and links (those are in the element list). */
function ownText(el: Element): string {
  let out = '';
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? '';
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const e = node as Element;
    if (SKIP_TAGS.has(e.tagName.toUpperCase())) {
      // Keep link text: product titles and results are usually links.
      if (e.tagName.toUpperCase() === 'A') out += ' ' + (e.textContent ?? '') + ' ';
      return;
    }
    for (const c of Array.from(e.childNodes)) walk(c);
    out += ' ';
  };
  walk(el);
  return normalize(out);
}

/** Label + value siblings, e.g. <span class="k">Email</span><span>a@b.c</span>. */
function pairedText(el: Element): string | null {
  const kids = Array.from(el.children).filter((c) => !SKIP_TAGS.has(c.tagName.toUpperCase()) || c.tagName === 'A');
  if (kids.length !== 2) return null;
  const key = normalize(kids[0].textContent ?? '');
  const value = normalize(kids[1].textContent ?? '');
  if (!key || !value || key.length > 40) return null;
  return isSensitiveKey(key) ? `${key.replace(/[:：]$/, '')}: ${REDACTED}` : `${key.replace(/[:：]$/, '')}: ${value}`;
}

function tableRows(root: ParentNode): Array<{ el: Element; text: string }> {
  const out: Array<{ el: Element; text: string }> = [];
  for (const table of Array.from(root.querySelectorAll('table'))) {
    if (!isVisible(table)) continue;
    const headers = Array.from(table.querySelectorAll('thead th')).map((th) => normalize(th.textContent ?? ''));
    for (const tr of Array.from(table.querySelectorAll('tr'))) {
      const cells = Array.from(tr.children).filter((c) => c.tagName === 'TD' || c.tagName === 'TH');
      if (!cells.length || tr.parentElement?.tagName === 'THEAD') {
        if (cells.length) out.push({ el: tr, text: cells.map((c) => normalize(c.textContent ?? '')).join(' | ') });
        continue;
      }
      const texts = cells.map((c) => normalize(ownText(c)));
      // Row-key tables: first cell is the key ("Phone | 98450...").
      const rowKeySensitive = cells.length >= 2 && isSensitiveKey(texts[0]);
      const redacted = texts.map((t, i) => {
        if (rowKeySensitive && i > 0) return REDACTED;
        if (headers[i] && isSensitiveKey(headers[i])) return REDACTED; // column header is sensitive
        return t;
      });
      out.push({ el: tr, text: redacted.join(' | ') });
    }
  }
  return out;
}

/**
 * Collect redacted visible text blocks in document order.
 * Returns plain strings; callers must still run the outbound PII guard.
 */
export function collectPageText(root: Document | HTMLElement = document, opts: PageTextOptions = {}): string[] {
  return collectPageTextDetailed(root, opts).blocks;
}

/** Same as collectPageText, plus the elements whose text was redacted (masked in screenshots too). */
export function collectPageTextDetailed(
  root: Document | HTMLElement = document,
  opts: PageTextOptions = {}
): { blocks: string[]; redactedElements: Element[] } {
  const maxBlocks = opts.maxBlocks ?? 80;
  const maxBlockChars = opts.maxBlockChars ?? 240;
  const maxTotal = opts.maxTotalChars ?? 6000;

  type Item = { el: Element; text: string };
  const items: Item[] = [...tableRows(root)];
  const inTable = (el: Element) => !!el.closest('table');

  for (const el of Array.from(root.querySelectorAll(BLOCK_SELECTOR))) {
    if (inTable(el) || !isVisible(el)) continue;
    // Skip blocks nested inside another collected block (e.g. <p> inside <li>).
    const parentBlock = el.parentElement?.closest(BLOCK_SELECTOR);
    if (parentBlock && !inTable(parentBlock)) continue;

    let text: string;
    if (el.tagName === 'DD') {
      const dt = el.previousElementSibling;
      if (dt?.tagName === 'DT' && isSensitiveKey(dt.textContent ?? '')) text = REDACTED;
      else text = ownText(el);
    } else {
      text = pairedText(el) ?? ownText(el);
    }
    if (text) items.push({ el, text });
  }

  // Text that lives directly in divs/spans (product cards, prices, badges).
  for (const el of Array.from(root.querySelectorAll('div,span,strong,b,em,small,time,label,section,article,main,header,footer,nav'))) {
    if (inTable(el) || el.closest(BLOCK_SELECTOR) || SKIP_TAGS.has(el.tagName.toUpperCase()) || el.closest('button,a,select')) continue;
    const direct = normalize(
      Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent ?? '')
        .join(' ')
    );
    if (!direct || !isVisible(el)) continue;
    items.push({ el, text: el.tagName === 'LABEL' ? direct : pairedText(el) ?? direct });
  }

  items.sort((a, b) => (a.el === b.el ? 0 : a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));

  const out: string[] = [];
  const redactedElements: Element[] = [];
  const seen = new Set<string>();
  let total = 0;
  let previousWasKey = false;
  for (const it of items) {
    let t = redactKeyValue(it.text);
    const isKey = BARE_KEY.test(t);
    // Value that follows a bare personal key in a separate element ("Name" / "Ajay Kumar").
    if (previousWasKey && !isKey) t = REDACTED;
    previousWasKey = isKey;
    // Mask in screenshots too: redacted values and anything the PII guard will catch ("Welcome back, Ajay").
    if (t.includes(REDACTED) || findPii(t).length > 0) redactedElements.push(it.el);
    if (t.length > maxBlockChars) t = t.slice(0, maxBlockChars - 1) + '…';
    if (!t || seen.has(t)) continue;
    seen.add(t);
    if (total + t.length > maxTotal || out.length >= maxBlocks) break;
    out.push(t);
    total += t.length;
  }
  return { blocks: out, redactedElements };
}
