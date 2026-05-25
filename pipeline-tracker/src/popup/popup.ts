import { STORAGE_KEYS, type HistoryEntry, type PipelineEvent } from '../types.ts';

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function formatTimeShort(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function prettyEventType(t: HistoryEntry['event_type']): string {
  switch (t) {
    case 'connection_request':
      return 'connection request';
    case 'accepted_connection':
      return 'accepted';
    case 'direct_message':
      return 'direct message';
  }
}

function iconChar(status: HistoryEntry['status']): string {
  return status === 'ok' ? '✓' : '⚠';
}

function showSetupMode(): void {
  (document.getElementById('setup-mode') as HTMLElement).style.display = '';
  (document.getElementById('configured-mode') as HTMLElement).style.display = 'none';
}

function showConfiguredMode(): void {
  (document.getElementById('setup-mode') as HTMLElement).style.display = 'none';
  (document.getElementById('configured-mode') as HTMLElement).style.display = '';
}

export function renderHistory(entries: HistoryEntry[]): void {
  const section = document.getElementById('history') as HTMLElement;
  const list = document.getElementById('history-list') as HTMLElement;
  list.replaceChildren();

  if (entries.length === 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';

  for (const entry of entries) {
    const wrap = document.createElement('details');
    wrap.className = 'history-entry';

    const summary = document.createElement('summary');
    summary.className = 'history-head';

    const icon = document.createElement('span');
    icon.className = `history-icon ${entry.status}`;
    icon.textContent = iconChar(entry.status);

    const time = document.createElement('span');
    time.className = 'history-time';
    time.textContent = formatTimeShort(entry.ts);

    const title = document.createElement('span');
    title.className = 'history-title';
    const displayName = entry.name || '(unknown)';
    title.textContent = `${displayName} — ${prettyEventType(entry.event_type)}`;

    summary.append(icon, time, title);
    wrap.appendChild(summary);

    const message = document.createElement('div');
    message.className = 'history-message';
    if (entry.status === 'partial' && entry.warnings.length > 0) {
      message.textContent = `Logged · missing: ${entry.warnings.join(', ')}`;
    } else {
      message.textContent = entry.message;
    }
    wrap.appendChild(message);

    const detail = document.createElement('pre');
    detail.className = 'history-detail';
    detail.textContent = JSON.stringify(entry, null, 2);
    wrap.appendChild(detail);

    list.appendChild(wrap);
  }
}

async function clearUnreadAndBadge(): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE_KEYS.UNREAD_COUNT]: 0,
    [STORAGE_KEYS.HIGHEST_SEVERITY]: 'ok',
  });
  if (chrome.action && typeof chrome.action.setBadgeText === 'function') {
    await chrome.action.setBadgeText({ text: '' });
  }
}

export async function initPopup(): Promise<void> {
  const keyInput = document.getElementById('api-key-input') as HTMLInputElement;
  const saveBtn = document.getElementById('save-btn') as HTMLButtonElement;
  const saveConfirm = document.getElementById('save-confirm') as HTMLElement;
  const statusEl = document.getElementById('status') as HTMLElement;
  const timestampEl = document.getElementById('timestamp') as HTMLElement;
  const lastErrorEl = document.getElementById('last-error') as HTMLElement;
  const debugToggle = document.getElementById('debug-toggle') as HTMLInputElement;
  const apiKeyError = document.getElementById('api-key-error') as HTMLElement;
  const testBtn = document.getElementById('test-btn') as HTMLButtonElement;
  const resetBtn = document.getElementById('reset-btn') as HTMLButtonElement;
  const testResult = document.getElementById('test-result') as HTMLElement;
  const clearHistoryBtn = document.getElementById('clear-history-btn') as HTMLButtonElement;

  const syncData = (await chrome.storage.sync.get([
    STORAGE_KEYS.API_KEY,
    STORAGE_KEYS.DEBUG_MODE,
  ])) as Record<string, unknown>;

  const apiKey = (syncData[STORAGE_KEYS.API_KEY] as string) || '';
  keyInput.value = apiKey;
  debugToggle.checked = !!syncData[STORAGE_KEYS.DEBUG_MODE];

  if (apiKey) {
    statusEl.textContent = 'Configured';
    statusEl.className = 'status configured';
    showConfiguredMode();
  } else {
    statusEl.textContent = 'Not configured';
    statusEl.className = 'status not-configured';
    showSetupMode();
  }

  const localData = (await chrome.storage.local.get([
    STORAGE_KEYS.LAST_LOGGED_AT,
    STORAGE_KEYS.LAST_ERROR,
    STORAGE_KEYS.HISTORY,
  ])) as Record<string, unknown>;

  const lastLoggedAt = localData[STORAGE_KEYS.LAST_LOGGED_AT] as string | undefined;
  if (lastLoggedAt) {
    timestampEl.textContent = `Last logged: ${formatTimestamp(lastLoggedAt)}`;
    timestampEl.style.display = '';
  }

  const lastError = localData[STORAGE_KEYS.LAST_ERROR] as string | null | undefined;
  if (lastError) {
    lastErrorEl.textContent = `Last POST failed: ${formatTimestamp(lastError)}`;
    lastErrorEl.style.display = '';
  }

  const history = (localData[STORAGE_KEYS.HISTORY] as HistoryEntry[] | undefined) ?? [];
  renderHistory(history);

  // Opening the popup acknowledges unread notifications.
  await clearUnreadAndBadge();

  saveBtn.addEventListener('click', async () => {
    const value = keyInput.value.trim();
    if (!value) {
      apiKeyError.style.display = '';
      return;
    }
    apiKeyError.style.display = 'none';
    await chrome.storage.sync.set({ [STORAGE_KEYS.API_KEY]: value });
    statusEl.textContent = 'Configured';
    statusEl.className = 'status configured';
    saveConfirm.style.display = '';
    setTimeout(() => {
      saveConfirm.style.display = 'none';
    }, 2000);
    showConfiguredMode();
  });

  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    testResult.style.display = 'none';

    const storedKey = (await chrome.storage.sync.get(STORAGE_KEYS.API_KEY)) as Record<
      string,
      unknown
    >;
    const currentKey = (storedKey[STORAGE_KEYS.API_KEY] as string) || '';

    const event: PipelineEvent = {
      api_key: currentKey,
      event_type: 'direct_message',
      name: 'Test Entry',
      title: '',
      linkedin_url: '',
      page_url: '',
      message_text: 'Test row from Pipeline Tracker setup — you can delete this.',
      date: new Date().toISOString().slice(0, 10),
    };

    const response = await new Promise<{ ok: boolean; message?: string }>((resolve) => {
      chrome.runtime.sendMessage(event, (res: { ok: boolean; message?: string }) => {
        resolve(res ?? { ok: false, message: 'No response from background' });
      });
    });

    testResult.style.display = '';
    if (response.ok) {
      testResult.textContent = 'Connection verified ✓';
      testResult.style.color = 'green';
    } else {
      testResult.textContent = response.message ?? 'Connection failed';
      testResult.style.color = 'red';
    }

    testBtn.disabled = false;

    // Re-render history (background just wrote a new entry) and clear badge again.
    const refreshed = (await chrome.storage.local.get(STORAGE_KEYS.HISTORY)) as Record<
      string,
      unknown
    >;
    renderHistory((refreshed[STORAGE_KEYS.HISTORY] as HistoryEntry[] | undefined) ?? []);
    await clearUnreadAndBadge();
  });

  resetBtn.addEventListener('click', async () => {
    await chrome.storage.sync.set({ [STORAGE_KEYS.API_KEY]: '' });
    keyInput.value = '';
    statusEl.textContent = 'Not configured';
    statusEl.className = 'status not-configured';
    testResult.style.display = 'none';
    showSetupMode();
  });

  debugToggle.addEventListener('change', async () => {
    await chrome.storage.sync.set({ [STORAGE_KEYS.DEBUG_MODE]: debugToggle.checked });
  });

  clearHistoryBtn.addEventListener('click', async () => {
    await chrome.storage.local.set({
      [STORAGE_KEYS.HISTORY]: [],
      [STORAGE_KEYS.UNREAD_COUNT]: 0,
      [STORAGE_KEYS.HIGHEST_SEVERITY]: 'ok',
    });
    renderHistory([]);
    if (chrome.action && typeof chrome.action.setBadgeText === 'function') {
      await chrome.action.setBadgeText({ text: '' });
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  void initPopup();
});
