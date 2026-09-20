import type { DomScanResult } from './dom';

/**
 * All message types exchanged between VeilBrowse extension components.
 * Content script ↔ Background service worker ↔ Popup.
 */
export type VeilBrowseMessageType =
  | 'DOM_SCAN_RESULT'
  | 'REQUEST_SCAN'
  | 'GET_LAST_SCAN'
  | 'SCAN_ERROR';

/** Base message — all messages extend this */
export interface VeilBrowseMessage {
  type: VeilBrowseMessageType;
}

/** Content script → Background: page scan completed successfully */
export interface DomScanResultMessage extends VeilBrowseMessage {
  type: 'DOM_SCAN_RESULT';
  payload: DomScanResult;
}

/** Popup → Background: request the most recent scan result */
export interface GetLastScanMessage extends VeilBrowseMessage {
  type: 'GET_LAST_SCAN';
}

/** Background → Popup: response with the latest scan, or empty if none */
export interface LastScanResponse {
  found: boolean;
  result?: DomScanResult;
}

/** Content script → Background: non-fatal scan error (no sensitive detail in message) */
export interface ScanErrorMessage extends VeilBrowseMessage {
  type: 'SCAN_ERROR';
  /** Generic error description — MUST NOT contain sensitive values */
  error: string;
}
