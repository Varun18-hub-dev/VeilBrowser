import { SensitiveElementType, type UnifiedSanitizedContext } from '@veilbrowse/shared-types';

/**
 * Visual perception request builder (content script side).
 *
 * The background worker takes a screenshot of the visible tab. Before any model sees it,
 * every sensitive region is filled black: sensitive or unknown form fields (from the
 * firewall) and text blocks whose values were redacted (e.g. "Name: Ajay Kumar").
 * Allowed controls get numbered boxes (set-of-marks) so the vision model can refer to
 * them, and we map the numbers back to element ids.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisualRequestPayload {
  task: string;
  masks: Rect[];
  marks: Array<{ n: number; rect: Rect }>;
  viewport: { width: number; height: number };
}

const PAD = 4;
const MAX_MARKS = 60;

function intersectsViewport(r: Rect, vw: number, vh: number): boolean {
  return r.width > 0 && r.height > 0 && r.x + r.width > 0 && r.y + r.height > 0 && r.x < vw && r.y < vh;
}

export function buildVisualRequest(
  context: UnifiedSanitizedContext,
  task: string,
  redactedTextElements: Element[],
  scroll: { x: number; y: number } = { x: window.scrollX, y: window.scrollY },
  viewport: { width: number; height: number } = { width: window.innerWidth, height: window.innerHeight }
): { payload: VisualRequestPayload; markToId: Map<number, string> } {
  const masks: Rect[] = [];
  const marks: Array<{ n: number; rect: Rect }> = [];
  const markToId = new Map<number, string>();

  for (const e of context.elements) {
    // Element bounds are document coordinates; the screenshot is the viewport.
    const r: Rect = { x: e.bounds.x - scroll.x, y: e.bounds.y - scroll.y, width: e.bounds.width, height: e.bounds.height };
    if (!intersectsViewport(r, viewport.width, viewport.height)) continue;
    const sensitive = e.decision !== 'ALLOWED' || e.category !== SensitiveElementType.NONE;
    if (sensitive) {
      masks.push({ x: r.x - PAD, y: r.y - PAD, width: r.width + 2 * PAD, height: r.height + 2 * PAD });
    } else if (e.interactable && marks.length < MAX_MARKS) {
      const n = marks.length + 1;
      marks.push({ n, rect: r });
      markToId.set(n, e.elementId);
    }
  }

  for (const el of redactedTextElements) {
    const b = el.getBoundingClientRect();
    const r: Rect = { x: b.left, y: b.top, width: b.width, height: b.height };
    if (intersectsViewport(r, viewport.width, viewport.height)) {
      masks.push({ x: r.x - PAD, y: r.y - PAD, width: r.width + 2 * PAD, height: r.height + 2 * PAD });
    }
  }

  return { payload: { task, masks, marks, viewport }, markToId };
}

/** Replace the vision model's box numbers ("[3]", "box 3", "#3") with element ids. */
export function mapMarksToIds(notes: string, markToId: Map<number, string>): string {
  return notes.replace(/\[(\d{1,3})\]|\b(?:box|mark|element)\s*#?(\d{1,3})\b|#(\d{1,3})\b/gi, (m, a, b, c) => {
    const id = markToId.get(Number(a ?? b ?? c));
    return id ? `[${id}]` : m;
  });
}
