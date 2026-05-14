import { STORAGE_KEYS, type TrackerEvent } from '../types.ts';

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

function today(): string {
  return new Date().toISOString().split('T')[0];
}

function showSetupMode(): void {
  (document.getElementById('setup-mode') as HTMLElement).style.display = '';
  (document.getElementById('configured-mode') as HTMLElement).style.display = 'none';
}

function showConfiguredMode(): void {
  (document.getElementById('setup-mode') as HTMLElement).style.display = 'none';
  (document.getElementById('configured-mode') as HTMLElement).style.display = '';
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

    const event: TrackerEvent = {
      api_key: currentKey,
      name: 'Test Entry',
      title: '',
      company: '',
      profile_url: '',
      page_url: '',
      message_type: 'Direct Message',
      message_text: 'Test row from LinkedIn Tracker setup — you can delete this.',
      date: today(),
      status: 'Sent',
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
}

document.addEventListener('DOMContentLoaded', () => {
  void initPopup();
});
