import { PageScanner } from './scanner';
import { applyOverlay } from './overlay';
import type { DomScanResultMessage, DomScanResult } from '@veilbrowse/shared-types';

/**
 * VeilBrowse Content Script — Entry Point (Phase 2)
 *
 * Runs at document_idle on http://localhost:3000/*
 *
 * Lifecycle:
 * 1. Initialize PageScanner with an onUpdate callback.
 * 2. On scan / mutation update:
 *    - Apply visual overlay (outlines + category badges).
 *    - Transmit sanitized DomScanResult to the background service worker.
 * 3. Start the continuous scanner (initial scan + MutationObserver).
 *
 * PRIVACY CONTRACT:
 * - Scanned elements never contain field values or passwords.
 * - Raw MutationRecords are never sent; only sanitized DomScanResults cross boundaries.
 * - Fail closed: if an unhandled error occurs, transmission is halted.
 */

console.log('[VeilBrowse] Content script active with dynamic PageScanner.');

function handleScanUpdate(result: DomScanResult): void {
  try {
    // Log summary counts only — never log element values or sensitive content
    console.log(
      `[VeilBrowse] Scan update: total=${result.summary.total} sensitive=${result.summary.sensitive}`,
      result.summary.byType
    );

    applyOverlay(result.elements);

    const message: DomScanResultMessage = {
      type: 'DOM_SCAN_RESULT',
      payload: result,
    };

    chrome.runtime.sendMessage(message, (_response: unknown) => {
      if (chrome.runtime.lastError) {
        // Non-fatal: background may be idle or restarting
        console.warn(
          '[VeilBrowse] Could not reach background:',
          chrome.runtime.lastError.message
        );
      }
    });
  } catch (err: unknown) {
    console.error('[VeilBrowse] Error in scan update handler:', err);
  }
}

try {
  const scanner = new PageScanner(handleScanUpdate);
  scanner.start();
} catch (err: unknown) {
  console.error('[VeilBrowse] Scanner startup error — fail closed:', err);
}
