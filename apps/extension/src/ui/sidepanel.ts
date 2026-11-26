const taskInput = document.getElementById('task') as HTMLTextAreaElement;
const providerSelect = document.getElementById('provider') as HTMLSelectElement;
const runButton = document.getElementById('run') as HTMLButtonElement;
const statusPanel = document.getElementById('status') as HTMLDivElement;
const dot = document.getElementById('dot') as HTMLSpanElement;
const state = document.getElementById('state') as HTMLSpanElement;
const detail = document.getElementById('detail') as HTMLDivElement;
const privacy = document.getElementById('privacy') as HTMLDivElement;
const result = document.getElementById('result') as HTMLDivElement;
const stepsList = document.getElementById('steps') as HTMLOListElement;
const newButton = document.getElementById('new') as HTMLButtonElement;
const confirmBox = document.getElementById('confirm') as HTMLDivElement;
const confirmText = document.getElementById('confirm-text') as HTMLDivElement;
const approveButton = document.getElementById('approve') as HTMLButtonElement;
const denyButton = document.getElementById('deny') as HTMLButtonElement;

let activeTab: chrome.tabs.Tab | undefined;
let runningTabId: number | null = null;
let pendingConfirmationId: string | null = null;

// Keep the active tab cached, so the click handler can ask for site permission
// immediately (chrome.permissions.request must run within the user's click).
async function refreshActiveTab(): Promise<void> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tabs[0];
}
void refreshActiveTab();
chrome.tabs.onActivated.addListener(() => void refreshActiveTab());
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.url || info.status === 'complete') void refreshActiveTab();
});

try {
  const saved = localStorage.getItem('veilbrowse.provider');
  if (saved === 'qwen' || saved === 'mock') providerSelect.value = saved;
} catch {
  /* storage unavailable */
}
providerSelect.addEventListener('change', () => {
  try {
    localStorage.setItem('veilbrowse.provider', providerSelect.value);
  } catch {
    /* ignore */
  }
});

function setState(title: string, description: string, kind: 'busy' | 'done' | 'error' = 'busy'): void {
  statusPanel.classList.remove('hidden');
  state.textContent = title;
  detail.textContent = description;
  dot.className = kind === 'busy' ? 'dot busy' : kind === 'error' ? 'dot error' : 'dot';
}

function resetResult(): void {
  result.classList.add('hidden');
  result.classList.remove('warn');
  stepsList.classList.add('hidden');
  stepsList.innerHTML = '';
  newButton.classList.add('hidden');
  privacy.classList.add('hidden');
  confirmBox.classList.add('hidden');
}

function originPattern(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

function runAgent(): void {
  const task = taskInput.value.trim();
  if (!task) {
    taskInput.focus();
    return;
  }
  const tab = activeTab;
  const pattern = originPattern(tab?.url);
  if (!tab?.id || !pattern) {
    setState('Cannot run here', 'Open a regular website (http or https) and try again.', 'error');
    return;
  }

  // First call in the click handler: ask for access to this one site only.
  chrome.permissions.request({ origins: [pattern] }).then(
    (granted) => {
      if (!granted) {
        setState('Permission needed', `VeilBrowse needs access to ${new URL(tab.url as string).hostname} to read the page locally.`, 'error');
        return;
      }
      void startTask(tab.id as number, task);
    },
    (err: unknown) => setState('Permission error', err instanceof Error ? err.message : String(err), 'error')
  );
}

async function startTask(tabId: number, task: string): Promise<void> {
  resetResult();
  runButton.disabled = true;
  runningTabId = tabId;
  setState('Starting...', 'Reading the current page locally.');
  privacy.classList.remove('hidden');
  try {
    const response = (await chrome.runtime.sendMessage({
      type: 'RUN_AGENT_TASK_FROM_PANEL',
      targetTabId: tabId,
      payload: { task, provider: providerSelect.value === 'mock' ? 'mock' : 'qwen' },
    })) as { ok?: boolean; error?: string } | undefined;
    if (!response?.ok) throw new Error(response?.error || 'VeilBrowse could not start on this page.');
  } catch (error) {
    setState('Could not start', error instanceof Error ? error.message : 'Refresh the page and try again.', 'error');
    runButton.disabled = false;
  }
}

function answerConfirmation(approved: boolean): void {
  if (!pendingConfirmationId) return;
  void chrome.runtime.sendMessage({
    type: 'CONFIRM_ACTION_RESPONSE',
    confirmationId: pendingConfirmationId,
    approved,
    targetTabId: runningTabId ?? undefined,
  });
  pendingConfirmationId = null;
  confirmBox.classList.add('hidden');
}

const STATUS_TEXT: Record<string, [string, string]> = {
  'ANALYZING PAGE': ['Reading the page...', 'Scanning the page locally.'],
  REASONING: ['Planning...', 'The model sees only the sanitized page context.'],
  'VALIDATING ACTION': ['Checking the action...', 'Verifying the action against the safety policy.'],
  'AWAITING CONFIRMATION': ['Waiting for you', 'This action needs your approval.'],
  EXECUTING: ['Acting...', 'Performing the approved action.'],
};

interface StepView {
  step: number;
  action: string;
  targetLabel?: string | null;
  targetId?: string;
  outcome: string;
}

chrome.runtime.onMessage.addListener(
  (
    message: {
      type?: string;
      status?: string;
      currentStep?: string;
      confirmationId?: string;
      description?: string;
      step?: StepView;
      payload?: { finalResult?: string; status?: string; steps?: StepView[]; summary?: { piiMaskedInLabels?: number } };
    },
    sender: chrome.runtime.MessageSender
  ) => {
    if (!message || typeof message.type !== 'string') return;
    if (runningTabId !== null && sender.tab && sender.tab.id !== runningTabId) return;

    if (message.type === 'AGENT_STATUS_UPDATE') {
      const s = message.status || '';
      if (s === 'ERROR' || s === 'BLOCKED') {
        setState(s === 'BLOCKED' ? 'Stopped for your protection' : 'Could not complete', message.currentStep || '', 'error');
        runButton.disabled = false;
        return;
      }
      const [title, desc] = STATUS_TEXT[s] ?? ['Working...', ''];
      setState(title, message.currentStep || desc);
      return;
    }

    if (message.type === 'CONFIRM_ACTION_REQUEST' && message.confirmationId) {
      pendingConfirmationId = message.confirmationId;
      confirmText.textContent = message.description || 'Allow this action?';
      confirmBox.classList.remove('hidden');
      approveButton.focus();
      return;
    }

    if (message.type === 'AGENT_TASK_COMPLETED') {
      const status = message.payload?.status ?? 'COMPLETED';
      const ok = status === 'COMPLETED';
      setState(ok ? 'Done' : status === 'STOPPED' ? 'Stopped' : 'Blocked', ok ? 'The agent finished.' : 'The agent stopped safely.', ok ? 'done' : 'error');
      result.textContent = message.payload?.finalResult || '';
      result.classList.toggle('warn', !ok);
      result.classList.remove('hidden');
      const steps = message.payload?.steps ?? [];
      for (const st of steps) {
        const li = document.createElement('li');
        li.textContent = `${st.action}${st.targetLabel ? ` "${st.targetLabel}"` : ''} — ${st.outcome}`;
        stepsList.appendChild(li);
      }
      stepsList.classList.toggle('hidden', steps.length === 0);
      const masked = message.payload?.summary?.piiMaskedInLabels ?? 0;
      privacy.textContent = masked
        ? `🔒 Field values never left the page. ${masked} piece(s) of personal data in visible text were masked before reasoning.`
        : '🔒 Field values never left the page. The model saw only sanitized page structure.';
      privacy.classList.remove('hidden');
      confirmBox.classList.add('hidden');
      newButton.classList.remove('hidden');
      runButton.disabled = false;
      runningTabId = null;
    }
  }
);

runButton.addEventListener('click', runAgent);
approveButton.addEventListener('click', () => answerConfirmation(true));
denyButton.addEventListener('click', () => answerConfirmation(false));
newButton.addEventListener('click', () => {
  taskInput.value = '';
  resetResult();
  statusPanel.classList.add('hidden');
  taskInput.focus();
});
taskInput.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') runAgent();
});
