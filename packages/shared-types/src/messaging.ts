import type { DomScanResult } from './dom';

/**
 * All message types exchanged between VeilBrowse extension components.
 * Content script ↔ Background service worker ↔ Popup.
 */
export type VeilBrowseMessageType =
  | 'DOM_SCAN_RESULT'
  | 'REQUEST_SCAN'
  | 'GET_LAST_SCAN'
  | 'SCAN_ERROR'
  // Side panel -> background: run a task on a tab
  | 'RUN_AGENT_TASK_FROM_PANEL'
  // Background -> content script: start the task / is the script loaded?
  | 'START_AGENT_TASK'
  | 'PING_CONTENT'
  // Content script -> background: call the local LLM (sanitized prompt only)
  | 'LLM_CHAT_REQUEST'
  // Content script -> side panel: progress, confirmation requests, results
  | 'AGENT_STATUS_UPDATE'
  | 'AGENT_STEP_COMPLETED'
  | 'AGENT_TASK_COMPLETED'
  | 'CONFIRM_ACTION_REQUEST'
  // Side panel -> background -> content script: the user's answer
  | 'CONFIRM_ACTION_RESPONSE'
  // Side panel -> background: stop the running task / resume after granting site access
  | 'STOP_AGENT_TASK'
  | 'RESUME_AGENT_TASK'
  // Background -> side panel: the task moved to a site VeilBrowse may not read yet
  | 'NEED_SITE_ACCESS'
  // Content script -> background: an action is navigating away; resume on the next page
  | 'AGENT_NAVIGATING'
  // Content script -> background: screenshot + local vision model (sensitive regions masked)
  | 'VISUAL_PERCEPTION_REQUEST';

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

export type ProviderChoice = 'qwen' | 'mock';

/** Side panel -> background: run a task on the given tab. */
export interface RunAgentTaskFromPanelMessage extends VeilBrowseMessage {
  type: 'RUN_AGENT_TASK_FROM_PANEL';
  targetTabId: number;
  payload: { task: string; provider: ProviderChoice; visual?: boolean };
}

export interface VeilBrowseSettings {
  textModel: string;
  visionModel: string;
}

export const DEFAULT_SETTINGS: VeilBrowseSettings = {
  textModel: 'qwen2.5:3b',
  visionModel: 'qwen2.5vl:3b',
};

/** Background -> content script: start (or resume, with history) the agent loop. */
export interface StartAgentTaskMessage extends VeilBrowseMessage {
  type: 'START_AGENT_TASK';
  payload: {
    task: string;
    provider: ProviderChoice;
    visual: boolean;
    textModel: string;
    visionModel: string;
    /** StepRecord[] from earlier pages of the same task. */
    history: unknown[];
    piiMasked: number;
    maxSteps: number;
  };
}

/** Content script -> background: one chat call to the local Ollama model.
 *  The messages are built from UnifiedSanitizedContext only. */
export interface LlmChatRequestMessage extends VeilBrowseMessage {
  type: 'LLM_CHAT_REQUEST';
  payload: {
    model: string;
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  };
}

export interface LlmChatResponse {
  ok: boolean;
  content?: string;
  error?: string;
}

/** Content script -> side panel: the agent wants to perform a destructive click. */
export interface ConfirmActionRequestMessage extends VeilBrowseMessage {
  type: 'CONFIRM_ACTION_REQUEST';
  confirmationId: string;
  description: string;
}

/** Side panel -> background -> content script: user's decision. */
export interface ConfirmActionResponseMessage extends VeilBrowseMessage {
  type: 'CONFIRM_ACTION_RESPONSE';
  confirmationId: string;
  approved: boolean;
  targetTabId?: number;
}
