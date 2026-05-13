import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleMessage } from '../../../linkedin-tracker/src/background.ts';
import { STORAGE_KEYS, type TrackerEvent } from '../../../linkedin-tracker/src/types.ts';

const BASE_EVENT: TrackerEvent = {
  api_key: '',
  date: '2026-05-13',
  name: 'Jane Doe',
  title: 'Engineer',
  company: '',
  message_type: 'Connection Request',
  message_text: '',
  status: 'Sent',
};

describe('background handleMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('api_key absent → no fetch, console.warn', async () => {
    (chrome.storage.sync.get as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await handleMessage(BASE_EVENT);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No api_key configured'));
    warnSpy.mockRestore();
  });

  it('fetch throws → last_error written, last_logged_at not updated', async () => {
    (chrome.storage.sync.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      [STORAGE_KEYS.API_KEY]: 'my-api-key',
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));

    await handleMessage(BASE_EVENT);

    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      expect.objectContaining({ [STORAGE_KEYS.LAST_ERROR]: expect.any(String) }),
    );
    expect(chrome.storage.local.set).not.toHaveBeenCalledWith(
      expect.objectContaining({ [STORAGE_KEYS.LAST_LOGGED_AT]: expect.any(String) }),
    );
  });

  it('non-200 response → last_error written, last_logged_at not updated', async () => {
    (chrome.storage.sync.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      [STORAGE_KEYS.API_KEY]: 'my-api-key',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: () => Promise.resolve('Forbidden'),
      } as unknown as Response),
    );

    await handleMessage(BASE_EVENT);

    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      expect.objectContaining({ [STORAGE_KEYS.LAST_ERROR]: expect.any(String) }),
    );
    const setCalls = (chrome.storage.local.set as ReturnType<typeof vi.fn>).mock.calls;
    const calledWithLoggedAt = setCalls.some(
      (call) => STORAGE_KEYS.LAST_LOGGED_AT in (call[0] as Record<string, unknown>),
    );
    expect(calledWithLoggedAt).toBe(false);
  });

  it('200 response → last_logged_at updated, last_error cleared', async () => {
    (chrome.storage.sync.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      [STORAGE_KEYS.API_KEY]: 'my-api-key',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response));

    await handleMessage(BASE_EVENT);

    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      expect.objectContaining({
        [STORAGE_KEYS.LAST_LOGGED_AT]: expect.any(String),
        [STORAGE_KEYS.LAST_ERROR]: null,
      }),
    );
  });
});
