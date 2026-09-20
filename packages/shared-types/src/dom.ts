import type { SensitivityClassification } from './sensitivity';

/**
 * Bounding rectangle of a DOM element relative to the document origin
 * (viewport position + scroll offset).
 */
export interface ElementBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A serializable, privacy-safe representation of one scanned DOM element.
 *
 * PRIVACY CONTRACT — this type MUST NOT contain:
 *   - input.value or any form field value
 *   - password, email, phone, account number, or any PII value
 *   - raw textContent of sensitive inputs
 *
 * It contains structural and semantic metadata only.
 * `accessibleLabel` is the element's LABEL TEXT (e.g., "Email Address"),
 * not the element's current value.
 *
 * Every field in this type is safe to serialize and store locally.
 */
export interface ScannedElement {
  /** Stable VeilBrowse identifier, matches data-veil-id attribute on the DOM element */
  elementId: string;
  /** Lowercase HTML tag name (e.g., "input", "button", "a") */
  tagName: string;
  /** ARIA role — explicit role attribute if present, otherwise implicit role for tag */
  role: string | null;
  /**
   * Computed accessible name for this element.
   *
   * For inputs: derived from aria-label, aria-labelledby, <label for>, placeholder, or title.
   * For buttons/links: derived from visible text content.
   *
   * This is the LABEL, not the value. Example: "Email Address", not "user@example.com".
   */
  accessibleLabel: string | null;
  /** Bounding rectangle in document coordinates */
  bounds: ElementBounds;
  /** Whether this element can receive user interaction (click, focus, type) */
  interactable: boolean;
  /** Privacy classification for this element */
  sensitivity: SensitivityClassification;
  /** Whether this element resides inside an open Shadow DOM root */
  inShadowRoot?: boolean;
}

/**
 * Complete result of scanning a page's DOM.
 *
 * PRIVACY CONTRACT:
 *   - pageUrl has query parameters stripped (may contain tokens)
 *   - elements contain structural metadata only, never form values
 *   - summary contains aggregate counts only
 *
 * This is the unit transmitted from content script → background service worker.
 */
export interface DomScanResult {
  /** Sanitized page URL — query parameters and fragment stripped */
  pageUrl: string;
  /** Document title */
  pageTitle: string;
  /** Unix timestamp (ms) when scan was completed */
  timestamp: number;
  /** All scanned elements in DOM order */
  elements: ScannedElement[];
  /** Aggregated statistics — safe to display in popup */
  summary: {
    total: number;
    sensitive: number;
    byType: Record<string, number>;
  };
}
