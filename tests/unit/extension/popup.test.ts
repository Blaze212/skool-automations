// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initPopup } from '../../../linkedin-tracker/src/popup/popup.ts';
import { STORAGE_KEYS } from '../../../linkedin-tracker/src/types.ts';

const POPUP_HTML = `
  <div id="status" class="status not-configured">Not configured</div>
  <input type="text" id="api-key-input" placeholder="Enter API key" />
  <div id="api-key-error" style="display:none">API key cannot be empty</div>
  <button id="save-btn">Save</button>
  <span id="save-confirm" style="display:none">Saved ✓</span>
  <div id="timestamp" style="display:none"></div>
  <div id="last-error" style="display:none"></div>
  <label><input type="checkbox" id="debug-toggle" /></label>
`;

describe('popup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = POPUP_HTML;
    (chrome.storage.sync.get as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (chrome.storage.sync.set as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  it('loads api_key from storage and fills input', async () => {
    (chrome.storage.sync.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      [STORAGE_KEYS.API_KEY]: 'existing-key',
    });
    await initPopup();
    expect((document.getElementById('api-key-input') as HTMLInputElement).value).toBe(
      'existing-key',
    );
  });

  it('shows Configured (green) when key is present', async () => {
    (chrome.storage.sync.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      [STORAGE_KEYS.API_KEY]: 'existing-key',
    });
    await initPopup();
    const status = document.getElementById('status')!;
    expect(status.textContent).toBe('Configured');
    expect(status.className).toContain('configured');
  });

  it('shows Not configured (grey) when key is absent', async () => {
    await initPopup();
    const status = document.getElementById('status')!;
    expect(status.textContent).toBe('Not configured');
    expect(status.className).toContain('not-configured');
  });

  it('shows Not configured when key is empty string', async () => {
    (chrome.storage.sync.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      [STORAGE_KEYS.API_KEY]: '',
    });
    await initPopup();
    expect(document.getElementById('status')!.textContent).toBe('Not configured');
  });

  it('save button writes api_key to storage', async () => {
    await initPopup();
    const input = document.getElementById('api-key-input') as HTMLInputElement;
    input.value = 'new-api-key';
    document.getElementById('save-btn')!.click();
    expect(chrome.storage.sync.set).toHaveBeenCalledWith({ [STORAGE_KEYS.API_KEY]: 'new-api-key' });
  });

  it('empty api_key does not save and shows error', async () => {
    await initPopup();
    const input = document.getElementById('api-key-input') as HTMLInputElement;
    input.value = '';
    document.getElementById('save-btn')!.click();
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
    expect(document.getElementById('api-key-error')!.style.display).not.toBe('none');
  });

  it('displays last_logged_at as formatted timestamp', async () => {
    (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      [STORAGE_KEYS.LAST_LOGGED_AT]: '2026-05-13T14:34:00.000Z',
    });
    await initPopup();
    const el = document.getElementById('timestamp')!;
    expect(el.style.display).not.toBe('none');
    expect(el.textContent).toContain('Last logged:');
  });

  it('shows last_error when set', async () => {
    (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      [STORAGE_KEYS.LAST_ERROR]: '2026-05-13T14:34:00.000Z',
    });
    await initPopup();
    const el = document.getElementById('last-error')!;
    expect(el.style.display).not.toBe('none');
    expect(el.textContent).toContain('Last POST failed:');
  });

  it('last_error hidden when absent', async () => {
    await initPopup();
    expect(document.getElementById('last-error')!.style.display).toBe('none');
  });

  it('debug_mode toggle reads from storage on open', async () => {
    (chrome.storage.sync.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      [STORAGE_KEYS.DEBUG_MODE]: true,
    });
    await initPopup();
    expect((document.getElementById('debug-toggle') as HTMLInputElement).checked).toBe(true);
  });

  it('debug_mode toggle writes to storage on change', async () => {
    await initPopup();
    const toggle = document.getElementById('debug-toggle') as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    expect(chrome.storage.sync.set).toHaveBeenCalledWith({ [STORAGE_KEYS.DEBUG_MODE]: true });
  });
});
