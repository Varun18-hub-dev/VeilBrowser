import { DEFAULT_SETTINGS } from '@veilbrowse/shared-types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const taskInput = $<HTMLTextAreaElement>('task');
const runButton = $<HTMLButtonElement>('run');
const stopButton = $<HTMLButtonElement>('stop');
const activity = $<HTMLDivElement>('activity');
const metaStep = $<HTMLSpanElement>('meta-step');
const metaPrivacy = $<HTMLSpanElement>('meta-privacy');
const result = $<HTMLDivElement>('result');
const privacy = $<HTMLDivElement>('privacy');
const stepsBox = $<HTMLDetailsElement>('steps-box');
const stepsList = $<HTMLOListElement>('steps');
const confirmBox = $<HTMLDivElement>('confirm');
const confirmText = $<HTMLDivElement>('confirm-text');
const accessBox = $<HTMLDivElement>('access');
const accessText = $<HTMLDivElement>('access-text');
const providerSelect = $<HTMLSelectElement>('provider');
const visualToggle = $<HTMLInputElement>('visual');
const textModel = $<HTMLInputElement>('text-model');
const visionModel = $<HTMLInputElement>('vision-model');

type Stage = 'understand' | 'inspect' | 'protect' | 'execute';
const STAGES: Stage[] = ['understand', 'inspect', 'protect', 'execute'];

let activeTab: chrome.tabs.Tab | undefined;
let runningTabId: number | null = null;
let pendingConfirmationId: string | null = null;
let pendingAccess: { tabId: number; pattern: string } | null = null;

// ---------------------------------------------------------------- settings

const SETTINGS_KEY = 'veilbrowse.settings';
const PREFS_KEY = 'veilbrowse.prefs';
void chrome.storage.local.get([SETTINGS_KEY, PREFS_KEY]).then((s) => {
  const settings = { ...DEFAULT_SETTINGS, ...(s[SETTINGS_KEY] ?? {}) };
  textModel.value = settings.textModel;
  visionModel.value = settings.visionModel;
  const prefs = s[PREFS_KEY] ?? {};
  if (prefs.provider === 'mock' || prefs.provider === 'qwen') providerSelect.value = prefs.provider;
  visualToggle.checked = prefs.visual === true;
});
function saveSettings(): void {
  void chrome.storage.local.set({
    [SETTINGS_KEY]: { textModel: textModel.value.trim() || DEFAULT_SETTINGS.textModel, visionModel: visionModel.value.trim() || DEFAULT_SETTINGS.visionModel },
    [PREFS_KEY]: { provider: providerSelect.value, visual: visualToggle.checked },
  });
}
for (const el of [textModel, visionModel, providerSelect]) el.addEventListener('change', saveSettings);

// Screenshots need Chrome's "all sites" permission; ask only when the user turns visual mode on.
visualToggle.addEventListener('change', () => {
  if (!visualToggle.checked) {
    saveSettings();
    return;
  }
  chrome.permissions.request({ origins: ['<all_urls>'] }).then(
    (granted) => {
      visualToggle.checked = granted;
      saveSettings();
    },
    () => {
      visualToggle.checked = false;
      saveSettings();
    }
  );
});

// Keep the active tab cached, so the click handler can ask for site permission
// immediately (chrome.permissions.request must run within the user's click).
// Testing aid: sidepanel.html?tabId=N targets that tab (only extension pages can open this URL).
const pinnedTabId = Number(new URLSearchParams(location.search).get('tabId')) || null;
async function refreshActiveTab(): Promise<void> {
  if (pinnedTabId) {
    activeTab = await chrome.tabs.get(pinnedTabId).catch(() => undefined);
    return;
  }
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tabs[0];
}
void refreshActiveTab();
chrome.tabs.onActivated.addListener(() => void refreshActiveTab());
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.url || info.status === 'complete') void refreshActiveTab();
});

// ---------------------------------------------------------------- view

function setStage(stage: Stage | null, detail?: string, error = false): void {
  activity.classList.remove('hidden');
  const idx = stage ? STAGES.indexOf(stage) : STAGES.length;
  activity.querySelectorAll<HTMLLIElement>('li[data-stage]').forEach((li, i) => {
    li.classList.remove('active', 'done', 'error');
    if (i < idx) li.classList.add('done');
    else if (i === idx) li.classList.add(error ? 'error' : 'active');
    if (i === idx && detail) (li.querySelector('.d') as HTMLElement).textContent = detail;
  });
}

function resetView(): void {
  for (const el of [result, privacy, stepsBox, confirmBox, accessBox]) el.classList.add('hidden');
  result.classList.remove('warn');
  stepsList.innerHTML = '';
  metaStep.textContent = 'Step 0';
  metaPrivacy.textContent = '0 items protected';
  activity.querySelectorAll<HTMLElement>('li .d').forEach((d, i) => {
    d.textContent = ['Processing the task', 'Identifying relevant elements', 'Sanitizing webpage context', 'Validating and performing browser actions'][i];
  });
}

function setRunning(running: boolean): void {
  runButton.disabled = running;
  stopButton.classList.toggle('hidden', !running);
}

function showError(text: string): void {
  setStage('understand', text, true);
  result.textContent = text;
  result.classList.add('warn');
  result.classList.remove('hidden');
  setRunning(false);
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

// ---------------------------------------------------------------- actions

function runAgent(): void {
  const task = taskInput.value.trim();
  if (!task) {
    taskInput.focus();
    return;
  }
  const tab = activeTab;
  const pattern = originPattern(tab?.url);
  resetView();
  if (!tab?.id || !pattern) {
    showError('Open a regular website (http or https) and try again.');
    return;
  }
  // First call in the click handler: ask for access to this one site only.
  chrome.permissions.request({ origins: [pattern] }).then(
    (granted) => {
      if (!granted) {
        showError(`VeilBrowse needs access to ${new URL(tab.url as string).hostname} to read the page locally.`);
        return;
      }
      void startTask(tab.id as number, task);
    },
    (err: unknown) => showError(err instanceof Error ? err.message : String(err))
  );
}

async function startTask(tabId: number, task: string): Promise<void> {
  setRunning(true);
  runningTabId = tabId;
  setStage('understand', 'Processing the task');
  try {
    const response = (await chrome.runtime.sendMessage({
      type: 'RUN_AGENT_TASK_FROM_PANEL',
      targetTabId: tabId,
      payload: { task, provider: providerSelect.value === 'mock' ? 'mock' : 'qwen', visual: visualToggle.checked },
    })) as { ok?: boolean; error?: string } | undefined;
    if (!response?.ok) throw new Error(response?.error || 'VeilBrowse could not start on this page.');
  } catch (error) {
    showError(error instanceof Error ? error.message : 'Refresh the page and try again.');
    runningTabId = null;
  }
}

function answerConfirmation(approved: boolean): void {
  if (!pendingConfirmationId) return;
  void chrome.runtime.sendMessage({ type: 'CONFIRM_ACTION_RESPONSE', confirmationId: pendingConfirmationId, approved, targetTabId: runningTabId ?? undefined });
  pendingConfirmationId = null;
  confirmBox.classList.add('hidden');
}

function allowSite(): void {
  const access = pendingAccess;
  if (!access) return;
  chrome.permissions.request({ origins: [access.pattern] }).then((granted) => {
    accessBox.classList.add('hidden');
    pendingAccess = null;
    if (granted) void chrome.runtime.sendMessage({ type: 'RESUME_AGENT_TASK', targetTabId: access.tabId });
    else void chrome.runtime.sendMessage({ type: 'STOP_AGENT_TASK', targetTabId: access.tabId });
  });
}

function stopTask(): void {
  if (runningTabId !== null) void chrome.runtime.sendMessage({ type: 'STOP_AGENT_TASK', targetTabId: runningTabId });
  accessBox.classList.add('hidden');
  answerConfirmation(false);
}

// ---------------------------------------------------------------- messages

interface StepView {
  step: number;
  action: string;
  targetLabel?: string | null;
  text?: string;
  outcome: string;
}

function stepText(s: StepView): string {
  const verb = s.action === 'TYPE' ? `Typed "${s.text ?? ''}"${s.targetLabel ? ` in ${s.targetLabel}` : ''}`
    : s.action === 'CLICK' ? `Clicked ${s.targetLabel ? `"${s.targetLabel}"` : 'an element'}`
    : s.action === 'SCROLL' ? 'Scrolled' : s.action === 'NAVIGATE' ? 'Opened a page' : s.action === 'WAIT' ? 'Waited' : s.action;
  const outcome = s.outcome === 'EXECUTED' ? '' : ` (${s.outcome.toLowerCase().replace(/_/g, ' ')})`;
  return verb + outcome;
}

chrome.runtime.onMessage.addListener(
  (
    message: {
      type?: string;
      status?: string;
      currentStep?: string;
      step?: number | StepView;
      piiMasked?: number;
      redactedCount?: number;
      confirmationId?: string;
      description?: string;
      tabId?: number;
      pattern?: string;
      host?: string;
      payload?: { finalResult?: string; status?: string; steps?: StepView[]; summary?: { piiMaskedInLabels?: number; redactedCount?: number } };
    },
    sender: chrome.runtime.MessageSender
  ) => {
    if (!message || typeof message.type !== 'string') return;
    if (runningTabId === null) return;
    if (sender.tab && sender.tab.id !== runningTabId) return;

    switch (message.type) {
      case 'AGENT_STATUS_UPDATE': {
        if (typeof message.step === 'number') metaStep.textContent = `Step ${message.step}`;
        const s = message.status;
        if (s === 'ANALYZING PAGE' || s === 'NAVIGATING') setStage('inspect', message.currentStep);
        else if (s === 'SANITIZING CONTEXT') {
          const n = (message.piiMasked ?? 0) + (message.redactedCount ?? 0);
          metaPrivacy.textContent = `${n} item${n === 1 ? '' : 's'} protected`;
          setStage('protect', 'Sensitive information protected locally');
        } else if (s === 'REASONING') setStage('understand', message.currentStep);
        else if (s === 'VALIDATING ACTION' || s === 'EXECUTING' || s === 'AWAITING CONFIRMATION') setStage('execute', message.currentStep);
        return;
      }
      case 'CONFIRM_ACTION_REQUEST':
        if (message.confirmationId) {
          pendingConfirmationId = message.confirmationId;
          confirmText.textContent = message.description || 'Allow this action?';
          confirmBox.classList.remove('hidden');
        }
        return;
      case 'NEED_SITE_ACCESS':
        if (typeof message.tabId === 'number' && message.pattern) {
          pendingAccess = { tabId: message.tabId, pattern: message.pattern };
          accessText.textContent = `The task moved to ${message.host}. Allow VeilBrowse to read this site to continue?`;
          accessBox.classList.remove('hidden');
          setStage('inspect', `Waiting for access to ${message.host}`);
        }
        return;
      case 'AGENT_TASK_COMPLETED': {
        const p = message.payload ?? {};
        const ok = p.status === 'COMPLETED';
        if (ok) setStage(null);
        else setStage('execute', p.status === 'STOPPED' ? 'Stopped' : 'Stopped safely', true);
        result.textContent = p.finalResult || (ok ? 'Done.' : 'The agent stopped.');
        result.classList.toggle('warn', !ok);
        result.classList.remove('hidden');
        const steps = p.steps ?? [];
        stepsList.innerHTML = '';
        for (const st of steps) {
          const li = document.createElement('li');
          li.textContent = stepText(st);
          stepsList.appendChild(li);
        }
        stepsBox.classList.toggle('hidden', steps.length === 0);
        const masked = p.summary?.piiMaskedInLabels ?? 0;
        const redacted = p.summary?.redactedCount ?? 0;
        privacy.textContent = `🔒 Your form entries never left the page. ${redacted + masked} sensitive item(s) were hidden from the AI.`;
        privacy.classList.remove('hidden');
        confirmBox.classList.add('hidden');
        accessBox.classList.add('hidden');
        setRunning(false);
        runningTabId = null;
        return;
      }
      default:
        return;
    }
  }
);

runButton.addEventListener('click', runAgent);
stopButton.addEventListener('click', stopTask);
$('approve').addEventListener('click', () => answerConfirmation(true));
$('deny').addEventListener('click', () => answerConfirmation(false));
$('allow-site').addEventListener('click', allowSite);
$('deny-site').addEventListener('click', stopTask);
taskInput.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') runAgent();
});
