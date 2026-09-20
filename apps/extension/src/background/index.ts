import type {
  DomScanResultMessage,
  GetLastScanMessage,
  LastScanResponse,
  VeilBrowseMessage,
} from '@veilbrowse/shared-types';

const STORAGE_KEY = 'veilbrowse_last_scan';

/**
 * VeilBrowse Background Service Worker
 *
 * Responsibilities:
 * - Receive DOM scan results from the content script
 * - Store scan metadata in session storage (never field values)
 * - Respond to popup requests for the latest scan summary
 *
 * PRIVACY CONTRACT:
 * - We log counts and element types only
 * - We never log accessible labels, URLs with tokens, or any form values
 * - chrome.storage.session holds DomScanResult which contains metadata only
 *   (enforced by the ScannedElement type having no `value` field)
 */

chrome.runtime.onMessage.addListener(
  (
    message: VeilBrowseMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void
  ): boolean | undefined => {
    if (message.type === 'RUN_AGENT_TASK_FROM_PANEL') {
      const targetTabId =
        typeof (message as { targetTabId?: unknown }).targetTabId === 'number'
          ? (message as { targetTabId: number }).targetTabId
          : sender.tab?.id;

      if (typeof targetTabId === 'number') {
        chrome.tabs.sendMessage(targetTabId, message).catch((err: unknown) => {
          console.error('[VeilBrowse:background] Failed to reach active tab:', err);
        });
      }
      return undefined;
    }

    if (message.type === 'DOM_SCAN_RESULT') {
      handleDomScanResult(message as DomScanResultMessage, sender);
      sendResponse({ ok: true });
      return undefined;
    }

    if (message.type === 'GET_LAST_SCAN') {
      const _msg = message as GetLastScanMessage;
      void _msg;
      // Return true to keep the message channel open for the async response
      void handleGetLastScan(sendResponse);
      return true;
    }

    return undefined;
  }
);

function handleDomScanResult(
  message: DomScanResultMessage,
  sender: chrome.runtime.MessageSender
): void {
  const { payload } = message;

  // PRIVACY: log counts only — never element values, labels, or URLs with tokens
  console.log(
    `[VeilBrowse:background] Scan received from tab ${sender.tab?.id ?? 'unknown'}.` +
    ` total=${payload.summary.total} sensitive=${payload.summary.sensitive}`
  );

  // Store the full DomScanResult in session storage.
  // DomScanResult contains structural metadata only — no field values.
  chrome.storage.session.set({ [STORAGE_KEY]: payload }).catch((err: unknown) => {
    console.error('[VeilBrowse:background] Failed to store scan result:', err);
  });
}

async function handleGetLastScan(
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const stored = await chrome.storage.session.get(STORAGE_KEY);
    if (stored[STORAGE_KEY]) {
      const response: LastScanResponse = { found: true, result: stored[STORAGE_KEY] };
      sendResponse(response);
    } else {
      const response: LastScanResponse = { found: false };
      sendResponse(response);
    }
  } catch (_err) {
    const response: LastScanResponse = { found: false };
    sendResponse(response);
  }
}


chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onStartup.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});
