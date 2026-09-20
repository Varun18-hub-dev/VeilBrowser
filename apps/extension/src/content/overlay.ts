import type { ScannedElement } from '@veilbrowse/shared-types';
import { VEILBROWSE_INTERNAL_ATTR } from './scanner';

const STYLE_ID = 'veilbrowse-styles';
const BADGE_CONTAINER_ID = 'veilbrowse-badges';
const BADGE_CLASS = 'vb-badge';

/**
 * Outline colors per sensitivity category.
 * These are visible indicators only — they never reveal the element's value.
 */
const SENSITIVE_COLORS: Readonly<Record<string, string>> = {
  password: '#e53e3e', // red
  email:    '#dd6b20', // orange
  phone:    '#d69e2e', // amber
  address:  '#805ad5', // purple
  identity: '#c53030', // dark red
  payment:  '#d53f8c', // magenta/pink
  unknown:  '#718096', // slate gray (fail-closed indicator)
};

const SAFE_COLOR = '#2b6cb0'; // blue — safe interactive elements

/**
 * CSS.escape polyfill (mirrors the one in scanner.ts).
 */
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/([^\w-])/g, '\\$1');
}

/**
 * Return true if node is owned by VeilBrowse overlay.
 */
export function isVeilBrowseNode(node: Node): boolean {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const el = node as Element;
  if (el.hasAttribute(VEILBROWSE_INTERNAL_ATTR)) return true;
  return el.closest(`[${VEILBROWSE_INTERNAL_ATTR}]`) !== null;
}

/**
 * Inject the VeilBrowse stylesheet.
 * Idempotent — safe to call multiple times.
 */
function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.setAttribute(VEILBROWSE_INTERNAL_ATTR, 'true');
  style.textContent = `
    /* VeilBrowse: sensitive element indicator */
    [data-veil-sensitive="true"] {
      outline: 2px solid var(--vb-color, #e53e3e) !important;
      outline-offset: 2px !important;
    }
    /* VeilBrowse: safe interactive element indicator */
    [data-veil-safe="true"] {
      outline: 2px solid ${SAFE_COLOR} !important;
      outline-offset: 2px !important;
    }
    /* Badge: shows category label near element */
    .${BADGE_CLASS} {
      position: absolute;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 9px;
      font-weight: 700;
      line-height: 14px;
      color: #fff;
      padding: 1px 5px;
      border-radius: 3px;
      pointer-events: none;
      z-index: 2147483647;
      white-space: nowrap;
      letter-spacing: 0.4px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.45);
    }
    /* Badge container — positioned at document origin */
    #${BADGE_CONTAINER_ID} {
      position: absolute;
      top: 0;
      left: 0;
      width: 0;
      height: 0;
      z-index: 2147483646;
      pointer-events: none;
    }
  `;
  document.head.appendChild(style);
}

/**
 * Get or create the container for all VeilBrowse badges.
 */
function getBadgeContainer(): HTMLElement {
  let container = document.getElementById(BADGE_CONTAINER_ID);
  if (!container) {
    container = document.createElement('div');
    container.id = BADGE_CONTAINER_ID;
    container.setAttribute(VEILBROWSE_INTERNAL_ATTR, 'true');
    document.body.appendChild(container);
  }
  return container;
}

/**
 * Create a category badge positioned at the top-right of the given element.
 *
 * PRIVACY INVARIANT:
 * - Badge text is the CATEGORY NAME only (e.g., "PASSWORD", "EMAIL")
 * - Badge never displays the element's value
 * - No accessible label, URL, or field content is rendered
 */
function createBadge(
  element: HTMLElement,
  categoryLabel: string,
  color: string
): HTMLElement {
  const badge = document.createElement('span');
  badge.className = BADGE_CLASS;
  badge.setAttribute(VEILBROWSE_INTERNAL_ATTR, 'true');
  badge.textContent = categoryLabel; // category name only — never the field value
  badge.style.backgroundColor = color;

  // Position at top-right of element in document coordinates
  const rect = element.getBoundingClientRect();
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;

  badge.style.left = `${Math.round(rect.right + scrollX - 2)}px`;
  badge.style.top  = `${Math.round(rect.top  + scrollY - 11)}px`;

  return badge;
}

/**
 * Apply the VeilBrowse visual overlay to all scanned elements.
 *
 * Sensitive elements: colored outline + category badge.
 * Safe interactable elements: blue outline, no badge.
 *
 * PRIVACY INVARIANT:
 * - Badge text is the category name only ("PASSWORD", "EMAIL", etc.)
 * - No field values, accessible labels, or user data are rendered in the overlay
 */
export function applyOverlay(elements: ScannedElement[]): void {
  injectStyles();
  const container = getBadgeContainer();

  // Clear any existing badges before re-rendering
  container.innerHTML = '';

  const activeElementIds = new Set(elements.map((e) => e.elementId));

  // Clear stale attributes on elements that are no longer in the scan
  document.querySelectorAll<HTMLElement>('[data-veil-sensitive]').forEach((el) => {
    const id = el.getAttribute('data-veil-id');
    if (!id || !activeElementIds.has(id)) {
      el.removeAttribute('data-veil-sensitive');
      el.style.removeProperty('--vb-color');
    }
  });

  document.querySelectorAll<HTMLElement>('[data-veil-safe]').forEach((el) => {
    const id = el.getAttribute('data-veil-id');
    if (!id || !activeElementIds.has(id)) {
      el.removeAttribute('data-veil-safe');
    }
  });

  for (const scanned of elements) {
    const el = document.querySelector<HTMLElement>(
      `[data-veil-id="${cssEscape(scanned.elementId)}"]`
    );
    if (!el) continue;

    if (scanned.sensitivity.isSensitive) {
      const color = SENSITIVE_COLORS[scanned.sensitivity.type] ?? '#e53e3e';
      el.setAttribute('data-veil-sensitive', 'true');
      el.style.setProperty('--vb-color', color);

      // Badge shows category name only — never the actual value
      const badge = createBadge(el, scanned.sensitivity.type.toUpperCase(), color);
      container.appendChild(badge);
    } else if (scanned.interactable) {
      el.setAttribute('data-veil-safe', 'true');
    }
  }
}

/**
 * Remove all VeilBrowse overlays from the page.
 * Useful for testing and future toggle functionality.
 */
export function removeOverlay(): void {
  document.getElementById(BADGE_CONTAINER_ID)?.remove();
  document.getElementById(STYLE_ID)?.remove();

  document.querySelectorAll<HTMLElement>('[data-veil-sensitive]').forEach((el) => {
    el.removeAttribute('data-veil-sensitive');
    el.style.removeProperty('--vb-color');
  });

  document.querySelectorAll<HTMLElement>('[data-veil-safe]').forEach((el) => {
    el.removeAttribute('data-veil-safe');
  });
}
