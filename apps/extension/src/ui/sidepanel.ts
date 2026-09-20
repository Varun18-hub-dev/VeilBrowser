const taskInput = document.getElementById('task') as HTMLTextAreaElement;
const runButton = document.getElementById('run') as HTMLButtonElement;
const statusPanel = document.getElementById('status') as HTMLDivElement;
const dot = document.getElementById('dot') as HTMLSpanElement;
const state = document.getElementById('state') as HTMLSpanElement;
const detail = document.getElementById('detail') as HTMLDivElement;
const privacy = document.getElementById('privacy') as HTMLDivElement;
const result = document.getElementById('result') as HTMLDivElement;
const newButton = document.getElementById('new') as HTMLButtonElement;

let activeTabId: number | null = null;

function setState(title: string, description: string, kind: 'busy' | 'done' | 'error' = 'busy'): void {
  statusPanel.classList.remove('hidden');
  state.textContent = title;
  detail.textContent = description;
  dot.className = kind === 'busy' ? 'dot busy' : kind === 'error' ? 'dot error' : 'dot';
}

function resetResult(): void {
  result.classList.add('hidden');
  newButton.classList.add('hidden');
  privacy.classList.add('hidden');
}

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function runAgent(): Promise<void> {
  const task = taskInput.value.trim();
  if (!task) {
    taskInput.focus();
    return;
  }

  const tab = await getActiveTab();
  activeTabId = tab?.id ?? null;
  if (!activeTabId) {
    setState('No active tab', 'Open a webpage and try again.', 'error');
    return;
  }

  resetResult();
  runButton.disabled = true;
  setState('Starting...', 'Reading the current page locally.');
  privacy.classList.remove('hidden');

  try {
    await chrome.tabs.sendMessage(activeTabId, {
      type: 'RUN_AGENT_TASK_FROM_PANEL',
      payload: { task, provider: 'qwen' },
    });
  } catch (_error) {
    setState('Extension not ready', 'Refresh the current page and try again.', 'error');
    runButton.disabled = false;
  }
}

chrome.runtime.onMessage.addListener((message: { type?: string; status?: string; currentStep?: string; payload?: { finalResult?: string } }) => {
  if (!message || typeof message.type !== 'string') return;

  if (message.type === 'AGENT_STATUS_UPDATE') {
    const statusName = message.status || '';
    if (statusName === 'ANALYZING PAGE') setState('Understanding the page...', 'Preparing the information needed for your task.');
    else if (statusName === 'SANITIZING CONTEXT') { setState('Protecting your information...', 'Sensitive information is protected locally.'); privacy.classList.remove('hidden'); }
    else if (statusName === 'REASONING') setState('Planning...', 'Qwen is reasoning only over sanitized page context.');
    else if (statusName === 'VALIDATING ACTION') setState('Checking the action...', 'VeilBrowse is verifying the action before execution.');
    else if (statusName === 'EXECUTING') setState('Executing...', 'The approved action is being performed in the browser.');
    else if (statusName === 'BLOCKED') { setState('Action stopped for your protection', 'The privacy policy blocked an unsafe or ambiguous action.', 'error'); runButton.disabled = false; }
    else if (statusName === 'ERROR') { setState('Could not complete safely', message.currentStep || 'The agent stopped without executing an unsafe action.', 'error'); runButton.disabled = false; }
    return;
  }

  if (message.type === 'AGENT_TASK_COMPLETED') {
    setState('Task completed', 'The requested browser action finished successfully.', 'done');
    result.textContent = message.payload?.finalResult || 'The task was completed.';
    result.classList.remove('hidden');
    newButton.classList.remove('hidden');
    runButton.disabled = false;
  }
});

runButton.addEventListener('click', () => { void runAgent(); });
newButton.addEventListener('click', () => {
  taskInput.value = '';
  resetResult();
  status.classList.add('hidden');
  taskInput.focus();
});
taskInput.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') void runAgent();
});