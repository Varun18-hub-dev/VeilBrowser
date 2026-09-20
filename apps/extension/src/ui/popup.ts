import type {
  GetLastScanMessage,
  LastScanResponse,
  DomScanResult,
} from '@veilbrowse/shared-types';

const SENSITIVE_COLORS: Readonly<Record<string, string>> = {
  password: '#e53e3e',
  email: '#dd6b20',
  phone: '#d69e2e',
  address: '#805ad5',
  identity: '#c53030',
  payment: '#d53f8c',
  unknown: '#718096',
};

function updateStatus(active: boolean): void {
  const pill = document.getElementById('status-pill');
  if (!pill) return;
  if (active) {
    pill.textContent = 'Active';
    pill.className = 'status-pill active';
  } else {
    pill.textContent = 'Waiting';
    pill.className = 'status-pill inactive';
  }
}

function renderScanResult(result: DomScanResult): void {
  const content = document.getElementById('content');
  if (!content) return;

  const { summary } = result;

  const typeEntries = Object.entries(summary.byType);

  let typesHtml = '';
  if (typeEntries.length > 0) {
    typesHtml = `
      <div class="section-label" style="margin-top: 12px;">Sensitive Categories</div>
      <div class="type-list">
        ${typeEntries
          .map(([type, count]) => {
            const color = SENSITIVE_COLORS[type] ?? '#e53e3e';
            return `
            <div class="type-row">
              <div class="type-name">
                <span class="dot" style="background-color: ${color};"></span>
                <span>${type.toUpperCase()}</span>
              </div>
              <span class="type-count">${count}</span>
            </div>
          `;
          })
          .join('')}
      </div>
    `;
  }

  content.innerHTML = `
    <div class="summary-row">
      <div class="stat">
        <div class="stat-num">${summary.total}</div>
        <div class="stat-label">Total Elements</div>
      </div>
      <div class="stat">
        <div class="stat-num warn">${summary.sensitive}</div>
        <div class="stat-label">Sensitive Elements</div>
      </div>
    </div>
    ${typesHtml}
  `;
}

function renderEmptyState(): void {
  const content = document.getElementById('content');
  if (!content) return;
  content.innerHTML = `
    <div class="idle-msg">
      No scan data available.<br>
      Open <code>http://localhost:3000</code> to view protected page.
    </div>
  `;
}

async function init(): Promise<void> {
  const message: GetLastScanMessage = {
    type: 'GET_LAST_SCAN',
  };

  chrome.runtime.sendMessage(message, (response: LastScanResponse | undefined) => {
    if (chrome.runtime.lastError || !response || !response.found || !response.result) {
      updateStatus(false);
      renderEmptyState();
      return;
    }

    updateStatus(true);
    renderScanResult(response.result);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  void init();
});
