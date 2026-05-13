import { STORAGE_KEYS } from '../types.ts';

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

function updateStatus(statusEl: HTMLElement, key: string): void {
  if (key) {
    statusEl.textContent = 'Configured';
    statusEl.className = 'status configured';
  } else {
    statusEl.textContent = 'Not configured';
    statusEl.className = 'status not-configured';
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

  const syncData = (await chrome.storage.sync.get([
    STORAGE_KEYS.API_KEY,
    STORAGE_KEYS.DEBUG_MODE,
  ])) as Record<string, unknown>;

  const apiKey = (syncData[STORAGE_KEYS.API_KEY] as string) || '';
  keyInput.value = apiKey;
  updateStatus(statusEl, apiKey);
  debugToggle.checked = !!syncData[STORAGE_KEYS.DEBUG_MODE];

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
    updateStatus(statusEl, value);
    saveConfirm.style.display = '';
    setTimeout(() => {
      saveConfirm.style.display = 'none';
    }, 2000);
  });

  debugToggle.addEventListener('change', async () => {
    await chrome.storage.sync.set({ [STORAGE_KEYS.DEBUG_MODE]: debugToggle.checked });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  void initPopup();
});
