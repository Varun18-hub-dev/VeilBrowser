import type { ScannedElement, DomScanResult, ElementBounds } from '@veilbrowse/shared-types';
import { classifyElement, getImplicitRole, isInteractable } from './classifier';

// ============================================================
// Constants
// ============================================================

/** Tags VeilBrowse considers relevant for scanning */
const SCANNABLE_TAGS: ReadonlySet<string> = new Set([
  'input', 'button', 'select', 'textarea', 'a',
]);

/**
 * Attribute that marks VeilBrowse-owned DOM nodes (overlay container, style tags).
 *
 * Loop-prevention strategy:
 * The MutationObserver fires on any childList/subtree change.
 * VeilBrowse itself mutates the DOM (injects badges, style tags).
 * To prevent those mutations from triggering further scans, every
 * VeilBrowse-injected node receives this attribute.
 * Before processing any MutationRecord, we check whether the target
 * or each added/removed node has this attribute. If so, we skip it.
 *
 * This attribute is exported so overlay.ts can mark its own nodes.
 */
export const VEILBROWSE_INTERNAL_ATTR = 'data-veil-internal';

// ============================================================
// Module-level element identity state
// ============================================================

/**
 * WeakMap<Element, string> is the AUTHORITATIVE source of element identity.
 *
 * Identity contract:
 * - Same DOM Element object reference → same `vb-N` ID (WeakMap lookup)
 * - Genuinely new Element object → new `vb-N` ID (even if structurally similar)
 * - DOM position is NOT identity
 * - `data-veil-id` attribute on elements is a DEBUG MIRROR of the WeakMap value only
 *
 * The WeakMap is module-scoped, living for the entire content-script lifetime.
 * Removed elements are garbage-collected naturally; their entries disappear from
 * the WeakMap automatically.
 */
const elementRegistry = new WeakMap<Element, string>();

/** Monotonically increasing counter. Never reset — IDs are permanent once assigned. */
let veilIdCounter = 0;

function nextVeilId(): string {
  veilIdCounter += 1;
  return `vb-${veilIdCounter}`;
}

/**
 * Get or assign a stable VeilBrowse ID to a DOM element.
 *
 * Checks the WeakMap first (authoritative). If no existing ID, allocates
 * a new one, stores it in the WeakMap, and mirrors it to the `data-veil-id`
 * attribute for browser DevTools inspection.
 */
function getOrAssignId(element: Element): string {
  const existing = elementRegistry.get(element);
  if (existing !== undefined) return existing;
  const id = nextVeilId();
  elementRegistry.set(element, id);
  // Mirror to attribute — debug/inspection only; NOT the authoritative source
  element.setAttribute('data-veil-id', id);
  return id;
}

// ============================================================
// DOM utility helpers
// ============================================================

/** CSS.escape polyfill for jsdom and older environments */
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/([^\w-])/g, '\\$1');
}

/** Bounding rectangle in document coordinates (viewport + scroll offset) */
function getElementBounds(element: HTMLElement): ElementBounds {
  const rect = element.getBoundingClientRect();
  return {
    x: Math.round(rect.left + window.scrollX),
    y: Math.round(rect.top + window.scrollY),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

/**
 * Find the text of the <label> associated with an input.
 * PRIVACY: Reads label text only, never the input's value.
 */
function getAssociatedLabelText(element: HTMLElement): string | null {
  const id = element.getAttribute('id');
  if (id) {
    const label = document.querySelector<HTMLLabelElement>(
      `label[for="${cssEscape(id)}"]`
    );
    if (label) return label.textContent?.trim() || null;
  }
  const ancestor = element.closest('label');
  if (ancestor) {
    const clone = ancestor.cloneNode(true) as HTMLElement;
    const inputInClone = clone.querySelector('input, select, textarea, button');
    if (inputInClone) clone.removeChild(inputInClone);
    return clone.textContent?.trim() || null;
  }
  return null;
}

/**
 * Compute the accessible label (name) for an element.
 *
 * PRIVACY CRITICAL — for form inputs we derive from:
 *   aria-label, aria-labelledby, <label>, placeholder, title.
 * We NEVER read input.value or textarea.value.
 *
 * For buttons/links: textContent IS the label (not a sensitive user value).
 */
function getAccessibleLabel(element: HTMLElement): string | null {
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel?.trim()) return ariaLabel.trim();

  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    const texts = labelledBy
      .split(/\s+/)
      .map((refId) => document.getElementById(refId)?.textContent?.trim())
      .filter(Boolean);
    if (texts.length > 0) return texts.join(' ');
  }

  const tag = element.tagName.toLowerCase();
  if (tag === 'button' || tag === 'a') {
    return element.textContent?.trim() || null;
  }

  const labelText = getAssociatedLabelText(element);
  if (labelText) return labelText;

  const placeholder = element.getAttribute('placeholder');
  if (placeholder?.trim()) return placeholder.trim();

  const title = element.getAttribute('title');
  if (title?.trim()) return title.trim();

  return null;
}

/** Return true if the element is not visible to the user */
function isHidden(element: HTMLElement): boolean {
  try {
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return true;
    if (style.opacity === '0') return true;
  } catch {
    // getComputedStyle failed (disconnected node) — treat as not hidden
  }
  return false;
}

/**
 * Return true if `node` is owned by VeilBrowse (overlay/style nodes).
 *
 * Checks the node itself and its closest ancestor for VEILBROWSE_INTERNAL_ATTR.
 * This is how we prevent the MutationObserver from reacting to VeilBrowse's
 * own DOM mutations and creating an infinite scanning loop.
 */
function isVeilBrowseInternal(node: Node): boolean {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const el = node as Element;
  if (el.hasAttribute(VEILBROWSE_INTERNAL_ATTR)) return true;
  return el.closest(`[${VEILBROWSE_INTERNAL_ATTR}]`) !== null;
}

/** Strip query params and fragment from URL before including in scan results */
function sanitizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '[invalid-url]';
  }
}

/** Build the summary block from a list of ScannedElements */
function buildSummary(elements: ScannedElement[]): DomScanResult['summary'] {
  const byType: Record<string, number> = {};
  let sensitiveCount = 0;
  for (const el of elements) {
    if (el.sensitivity.isSensitive) {
      sensitiveCount += 1;
      const typeName = el.sensitivity.type as string;
      byType[typeName] = (byType[typeName] ?? 0) + 1;
    }
  }
  return { total: elements.length, sensitive: sensitiveCount, byType };
}

// ============================================================
/**
 * Extract nearby structural context heading (legend or section/card title).
 *
 * PRIVACY BOUNDARY:
 * - Strictly bounded to nearby heading elements (legend, h1-h6, .card-title, .section-title).
 * - NEVER scrapes document.body.innerText or document.body.textContent.
 * - Caps length to 80 characters.
 */
function getContextHeading(element: HTMLElement): string | null {
  // Strategy 1: check enclosing fieldset > legend
  const fieldset = element.closest('fieldset');
  if (fieldset) {
    const legend = fieldset.querySelector('legend');
    if (legend && legend.textContent) {
      const text = legend.textContent.trim().replace(/\s+/g, ' ');
      if (text) return text.slice(0, 80);
    }
  }

  // Strategy 2: check closest structural container
  const container = element.closest('form, section, article, .card, [role="group"], [role="region"]');
  if (container) {
    const heading = container.querySelector('h1, h2, h3, h4, h5, h6, legend, .card-title, .section-title, .header-section h1');
    if (heading && heading.textContent) {
      const text = heading.textContent.trim().replace(/\s+/g, ' ');
      if (text) return text.slice(0, 80);
    }
  }

  return null;
}

/**
 * Scan a single DOM element and produce a privacy-safe ScannedElement record.
 *
 * PRIVACY CONTRACT:
 * - Never reads element.value
 * - Never reads textContent of <input> or <textarea>
 * - Assigns stable ID via WeakMap (mirrored to data-veil-id for debugging)
 * - accessibleLabel is the LABEL text, not the current field value
 *
 * @param element     The HTMLElement to scan
 * @param inShadowRoot  Whether this element lives inside an open Shadow DOM root
 * @returns ScannedElement or null if the element should be excluded
 */
export function scanElement(
  element: HTMLElement,
  inShadowRoot = false
): ScannedElement | null {
  const tagName = element.tagName.toLowerCase();
  const inputType = element.getAttribute('type')?.toLowerCase();

  if (tagName === 'input' && inputType === 'hidden') return null;
  if (isHidden(element)) return null;

  const elementId = getOrAssignId(element);
  const explicitRole = element.getAttribute('role');
  const implicitRole = getImplicitRole(tagName, inputType ?? undefined);
  const role = explicitRole ?? implicitRole;

  const accessibleLabel = getAccessibleLabel(element);
  const bounds = getElementBounds(element);
  const interactable = isInteractable(tagName, inputType ?? undefined, role);

  // PRIVACY: attribute values only — never element.value
  const attrs = {
    tagName,
    type:           inputType               ?? undefined,
    name:           element.getAttribute('name')         ?? undefined,
    id:             element.getAttribute('id')           ?? undefined,
    autocomplete:   element.getAttribute('autocomplete') ?? undefined,
    ariaLabel:      element.getAttribute('aria-label')   ?? undefined,
    placeholder:    element.getAttribute('placeholder')  ?? undefined,
    labelText:      getAssociatedLabelText(element)      ?? undefined,
    title:          element.getAttribute('title')        ?? undefined,
    contextHeading: getContextHeading(element)           ?? undefined,
  };

  const sensitivity = classifyElement(attrs);

  const result: ScannedElement = {
    elementId,
    tagName,
    role,
    accessibleLabel,
    bounds,
    interactable,
    sensitivity,
  };

  if (inShadowRoot) result.inShadowRoot = true;

  return result;
}

// ============================================================
// Subtree scan helper (used by scanPage and PageScanner)
// ============================================================

/**
 * Scan all scannable elements in a ParentNode subtree, including open shadow roots.
 *
 * Open Shadow DOM support:
 *   For each element that exposes a `.shadowRoot` (mode === 'open'),
 *   we recursively scan its contents. Elements inside shadow roots
 *   are tagged with `inShadowRoot: true`.
 *
 * Closed Shadow DOM limitation:
 *   Closed shadow roots (mode === 'closed') return null for `.shadowRoot`
 *   in content scripts due to browser security. VeilBrowse cannot traverse
 *   them and does not claim to do so.
 *
 * Attribute-only mutation limitation:
 *   This function classifies elements based on their attributes at scan time.
 *   If an attribute changes later (e.g. type="text" → type="password") without
 *   the element being removed and reinserted, the classification will not update.
 *   This is a documented Phase 2 limitation. Attribute observation is deliberately
 *   omitted from the MutationObserver configuration.
 */
function scanSubtree(root: ParentNode, inShadowRoot: boolean): ScannedElement[] {
  const selector = [...SCANNABLE_TAGS].join(', ');
  const results: ScannedElement[] = [];

  // Scan scannable elements in this root
  for (const el of root.querySelectorAll<HTMLElement>(selector)) {
    if (isVeilBrowseInternal(el)) continue;
    const scanned = scanElement(el, inShadowRoot);
    if (scanned) results.push(scanned);
  }

  // Find elements with open shadow roots and recurse into them
  for (const el of root.querySelectorAll<HTMLElement>('*')) {
    if (el.shadowRoot) {
      results.push(...scanSubtree(el.shadowRoot, true));
    }
  }

  return results;
}

// ============================================================
// Standalone snapshot scan (backward-compatible with Phase 1)
// ============================================================

/**
 * Perform a full-document snapshot scan.
 *
 * Used by Phase 1 privacy invariant tests and for one-shot snapshots.
 * Does NOT start continuous observation — use PageScanner for that.
 *
 * PRIVACY CONTRACT: Returns structural metadata only. No field values.
 */
export function scanPage(): DomScanResult {
  const elements = scanSubtree(document, false);
  return {
    pageUrl: sanitizeUrl(window.location.href),
    pageTitle: document.title,
    timestamp: Date.now(),
    elements,
    summary: buildSummary(elements),
  };
}

// ============================================================
// PageScanner — Continuously-updated live element representation
// ============================================================

/** Called after each batch update with the current sanitized scan result */
export type ScanUpdateCallback = (result: DomScanResult) => void;

/**
 * PageScanner maintains a continuously-updated, privacy-safe semantic representation
 * of the current page's interactive elements.
 *
 * Architecture:
 *
 *   DOM change
 *     ↓
 *   MutationObserver (childList + subtree only)
 *     ↓
 *   handleMutations: collect removed IDs + added subtree roots
 *     (VeilBrowse-internal nodes are filtered out here to prevent loops)
 *     ↓
 *   scheduleBatch: request a single requestAnimationFrame
 *     (multiple mutations in one event loop collapse into one rAF)
 *     ↓
 *   flushBatch (rAF callback):
 *     1. Remove pending removed IDs from currentElements
 *     2. Scan pending added subtrees, merge into currentElements
 *     3. Call onUpdate(buildScanResult())
 *
 * Known limitations (Phase 2, by design):
 *   - Attribute-only changes are NOT detected (e.g. type="text" → type="password"
 *     without node removal/insertion). Attribute observation is deliberately omitted.
 *   - Closed Shadow DOM cannot be traversed.
 */
export class PageScanner {
  /** Live element map: elementId → ScannedElement */
  private readonly currentElements = new Map<string, ScannedElement>();

  /** Batch queue: newly added DOM subtree roots to scan on next rAF */
  private readonly pendingAddedRoots = new Set<Node>();

  /**
   * Batch queue: element IDs to remove on next rAF.
   *
   * IDs are collected eagerly in the mutation callback (while node references
   * are still valid) via the WeakMap. This avoids relying on isConnected
   * checks after nodes have been removed.
   */
  private readonly pendingRemovedIds = new Set<string>();

  /** requestAnimationFrame handle; null when no flush is pending */
  private rafHandle: number | null = null;

  private observer: MutationObserver | null = null;
  private readonly onUpdate: ScanUpdateCallback | null;

  constructor(onUpdate?: ScanUpdateCallback) {
    this.onUpdate = onUpdate ?? null;
  }

  /**
   * Start the scanner: perform initial full scan, then begin observing mutations.
   */
  start(): void {
    this.performFullScan();

    this.observer = new MutationObserver(this.handleMutations.bind(this));
    this.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      // attributes: false — NOT observed (see documented limitation above)
    });
  }

  /**
   * Stop the scanner: disconnect observer and clear all state.
   */
  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    this.currentElements.clear();
    this.pendingAddedRoots.clear();
    this.pendingRemovedIds.clear();
  }

  /** Read-only view of the current live element representation */
  getElements(): ReadonlyMap<string, ScannedElement> {
    return this.currentElements;
  }

  /**
   * Build a DomScanResult from the current live representation.
   * Safe to serialize and transmit to the background service worker.
   *
   * PRIVACY: Contains structural metadata only. No field values.
   */
  buildScanResult(): DomScanResult {
    const elements = [...this.currentElements.values()];
    return {
      pageUrl: sanitizeUrl(window.location.href),
      pageTitle: document.title,
      timestamp: Date.now(),
      elements,
      summary: buildSummary(elements),
    };
  }

  // ------------------------------------------------------------------
  // Private: mutation handling
  // ------------------------------------------------------------------

  private handleMutations(records: MutationRecord[]): void {
    for (const record of records) {
      // Skip mutations caused by VeilBrowse's own overlay DOM changes
      // (badges container inserts, style tag insertion, etc.)
      if (isVeilBrowseInternal(record.target)) continue;

      // Collect removed element IDs eagerly while node references are live.
      // Using WeakMap (authoritative) instead of relying on isConnected.
      for (const node of record.removedNodes) {
        if (!isVeilBrowseInternal(node)) {
          this.collectRemovedIds(node);
        }
      }

      // Queue added subtrees for batch scanning
      for (const node of record.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE && !isVeilBrowseInternal(node)) {
          this.pendingAddedRoots.add(node);
        }
      }
    }

    if (this.pendingRemovedIds.size > 0 || this.pendingAddedRoots.size > 0) {
      this.scheduleBatch();
    }
  }

  /**
   * Recursively walk a removed subtree and record IDs of registered elements.
   *
   * Must be called while node references are still held (during or shortly after
   * the mutation callback). After GC, the WeakMap entries are gone.
   */
  private collectRemovedIds(node: Node): void {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;

    // WeakMap lookup — authoritative identity check
    const id = elementRegistry.get(el);
    if (id !== undefined && this.currentElements.has(id)) {
      this.pendingRemovedIds.add(id);
    }

    // Recurse into children of the removed subtree
    for (const child of el.children) {
      this.collectRemovedIds(child);
    }

    // Recurse into open shadow roots
    if (el.shadowRoot) {
      for (const child of el.shadowRoot.children) {
        this.collectRemovedIds(child);
      }
    }
  }

  /**
   * Schedule one requestAnimationFrame to process the accumulated batch.
   * Multiple mutations arriving before the next frame share a single flush.
   */
  private scheduleBatch(): void {
    if (this.rafHandle !== null) return; // already queued — batch accumulates
    this.rafHandle = requestAnimationFrame(() => {
      this.rafHandle = null;
      this.flushBatch();
    });
  }

  /**
   * Process the accumulated batch of removals and additions.
   * Called once per animation frame — not per mutation record.
   */
  private flushBatch(): void {
    let hasChanges = false;

    // 1. Apply removals
    for (const id of this.pendingRemovedIds) {
      if (this.currentElements.delete(id)) {
        hasChanges = true;
      }
    }
    this.pendingRemovedIds.clear();

    // 2. Scan new subtrees and merge into live representation
    for (const node of this.pendingAddedRoots) {
      if (this.scanAddedSubtree(node)) {
        hasChanges = true;
      }
    }
    this.pendingAddedRoots.clear();

    // 3. Notify — transmits only sanitized DomScanResult when changes occurred
    if (hasChanges) {
      this.onUpdate?.(this.buildScanResult());
    }
  }

  /**
   * Scan a newly added DOM subtree and add discovered elements to currentElements.
   * Returns true if any new element was discovered.
   */
  private scanAddedSubtree(node: Node): boolean {
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    const root = node as HTMLElement;
    let addedAny = false;

    // Check root itself
    if (SCANNABLE_TAGS.has(root.tagName.toLowerCase()) && !isVeilBrowseInternal(root)) {
      const scanned = scanElement(root, false);
      if (scanned && !this.currentElements.has(scanned.elementId)) {
        this.currentElements.set(scanned.elementId, scanned);
        addedAny = true;
      }
    }

    // Check descendants
    const selector = [...SCANNABLE_TAGS].join(', ');
    for (const el of root.querySelectorAll<HTMLElement>(selector)) {
      if (isVeilBrowseInternal(el)) continue;
      const scanned = scanElement(el, false);
      if (scanned && !this.currentElements.has(scanned.elementId)) {
        this.currentElements.set(scanned.elementId, scanned);
        addedAny = true;
      }
    }

    // Open shadow roots within the added subtree
    if (root.shadowRoot) {
      if (this.scanShadowSubtree(root.shadowRoot)) addedAny = true;
    }
    for (const el of root.querySelectorAll<HTMLElement>('*')) {
      if (el.shadowRoot) {
        if (this.scanShadowSubtree(el.shadowRoot)) addedAny = true;
      }
    }

    return addedAny;
  }

  private scanShadowSubtree(shadow: ShadowRoot): boolean {
    const selector = [...SCANNABLE_TAGS].join(', ');
    let addedAny = false;
    for (const el of shadow.querySelectorAll<HTMLElement>(selector)) {
      const scanned = scanElement(el, true);
      if (scanned && !this.currentElements.has(scanned.elementId)) {
        this.currentElements.set(scanned.elementId, scanned);
        addedAny = true;
      }
    }
    return addedAny;
  }

  /** Initial full-document scan to populate currentElements */
  private performFullScan(): void {
    this.currentElements.clear();
    for (const el of scanSubtree(document, false)) {
      this.currentElements.set(el.elementId, el);
    }
    this.onUpdate?.(this.buildScanResult());
  }
}
