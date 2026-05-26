import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleMessage } from '../../../pipeline-tracker/src/background.ts';
import {
  BADGE_COLOR_ERROR,
  BADGE_COLOR_OK,
  BADGE_COLOR_PARTIAL,
  BADGE_TEXT_ERROR,
  BADGE_TEXT_OK,
  BADGE_TEXT_PARTIAL,
  HISTORY_CAP,
  STORAGE_KEYS,
  type HistoryEntry,
  type PipelineEvent,
} from '../../../pipeline-tracker/src/types.ts';

function makeEvent(overrides: Partial<PipelineEvent> = {}): PipelineEvent {
  return {
    api_key: 'pk_test',
    event_type: 'connection_request',
    date: '2026-05-22',
    name: 'Jane Doe',
    title: 'CEO',
    linkedin_url: 'https://www.linkedin.com/in/jane',
    page_url: 'https://www.linkedin.com/in/jane/',
    message_text: '',
    ...overrides,
  };
}

interface LocalStore {
  [key: string]: unknown;
}

function installStatefulStorage(initialSync: LocalStore = { [STORAGE_KEYS.API_KEY]: 'pk_test' }): {
  local: LocalStore;
  sync: LocalStore;
} {
  const local: LocalStore = {};
  const sync: LocalStore = { ...initialSync };

  const read = (store: LocalStore, keys: string | string[] | undefined): LocalStore => {
    if (keys === undefined) return { ...store };
    const list = Array.isArray(keys) ? keys : [keys];
    const out: LocalStore = {};
    for (const k of list) {
      if (k in store) out[k] = store[k];
    }
    return out;
  };

  (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockImplementation(
    async (keys?: string | string[]) => read(local, keys),
  );
  (chrome.storage.local.set as ReturnType<typeof vi.fn>).mockImplementation(
    async (entries: LocalStore) => {
      Object.assign(local, entries);
    },
  );
  (chrome.storage.sync.get as ReturnType<typeof vi.fn>).mockImplementation(
    async (keys?: string | string[]) => read(sync, keys),
  );
  (chrome.storage.sync.set as ReturnType<typeof vi.fn>).mockImplementation(
    async (entries: LocalStore) => {
      Object.assign(sync, entries);
    },
  );

  return { local, sync };
}

function mockFetchOnce(response: { status: number; body?: unknown }): void {
  const body = response.body === undefined ? '' : JSON.stringify(response.body);
  globalThis.fetch = vi.fn().mockResolvedValueOnce(
    new Response(body, {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    }),
  ) as typeof fetch;
}

describe('pipeline-tracker background.handleMessage', () => {
  let stores: ReturnType<typeof installStatefulStorage>;

  beforeEach(() => {
    vi.clearAllMocks();
    stores = installStatefulStorage();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('on 200 success: records ok entry, does not increment unread, shows green bubble', async () => {
    mockFetchOnce({ status: 200, body: { success: true } });

    const result = await handleMessage(makeEvent());

    expect(result.ok).toBe(true);

    const history = stores.local[STORAGE_KEYS.HISTORY] as HistoryEntry[];
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe('ok');
    expect(history[0].message).toBe('Logged');
    expect(history[0].name).toBe('Jane Doe');

    expect(stores.local[STORAGE_KEYS.UNREAD_COUNT]).toBe(0);
    expect(stores.local[STORAGE_KEYS.HIGHEST_SEVERITY]).toBe('ok');
    expect(stores.local[STORAGE_KEYS.LAST_STATUS]).toBe('ok');

    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: BADGE_TEXT_OK });
    expect(chrome.action.setBadgeBackgroundColor).toHaveBeenLastCalledWith({
      color: BADGE_COLOR_OK,
    });
  });

  it('on 200 with warnings: classifies as partial and shows yellow bubble', async () => {
    mockFetchOnce({
      status: 200,
      body: { success: true, warnings: ['title missing'] },
    });

    const result = await handleMessage(makeEvent());

    expect(result.ok).toBe(true);

    const history = stores.local[STORAGE_KEYS.HISTORY] as HistoryEntry[];
    expect(history[0].status).toBe('partial');
    expect(history[0].warnings).toEqual(['title missing']);

    expect(stores.local[STORAGE_KEYS.LAST_STATUS]).toBe('partial');
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: BADGE_TEXT_PARTIAL });
    expect(chrome.action.setBadgeBackgroundColor).toHaveBeenLastCalledWith({
      color: BADGE_COLOR_PARTIAL,
    });
  });

  it('on 200 success but name AND linkedin_url both empty: shows red bubble', async () => {
    mockFetchOnce({ status: 200, body: { success: true } });

    const result = await handleMessage(makeEvent({ name: '', linkedin_url: '' }));

    expect(result.ok).toBe(true);

    const history = stores.local[STORAGE_KEYS.HISTORY] as HistoryEntry[];
    expect(history[0].status).toBe('error');

    expect(stores.local[STORAGE_KEYS.LAST_STATUS]).toBe('error');
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: BADGE_TEXT_ERROR });
    expect(chrome.action.setBadgeBackgroundColor).toHaveBeenLastCalledWith({
      color: BADGE_COLOR_ERROR,
    });
  });

  it('on 403: records error entry, increments unread, sets red bubble', async () => {
    mockFetchOnce({
      status: 403,
      body: { success: false, error: 'Unknown api_key', code: 'ACCESS_DENIED' },
    });

    const result = await handleMessage(makeEvent());

    expect(result.ok).toBe(false);
    expect(result.message).toBe('Sheet not shared or invalid API key');

    const history = stores.local[STORAGE_KEYS.HISTORY] as HistoryEntry[];
    expect(history[0].status).toBe('error');
    expect(history[0].http_status).toBe(403);
    expect(history[0].code).toBe('ACCESS_DENIED');

    expect(stores.local[STORAGE_KEYS.UNREAD_COUNT]).toBe(1);
    expect(stores.local[STORAGE_KEYS.HIGHEST_SEVERITY]).toBe('error');
    expect(stores.local[STORAGE_KEYS.LAST_STATUS]).toBe('error');

    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: BADGE_TEXT_ERROR });
    expect(chrome.action.setBadgeBackgroundColor).toHaveBeenLastCalledWith({
      color: BADGE_COLOR_ERROR,
    });
  });

  it('on 400 with server error message: uses server message verbatim', async () => {
    mockFetchOnce({
      status: 400,
      body: { success: false, error: 'Missing required field: name', code: 'VALIDATION_ERROR' },
    });

    const result = await handleMessage(makeEvent({ name: '' }));

    expect(result.ok).toBe(false);
    expect(result.message).toBe('Missing required field: name');

    const history = stores.local[STORAGE_KEYS.HISTORY] as HistoryEntry[];
    expect(history[0].message).toBe('Missing required field: name');
    expect(history[0].code).toBe('VALIDATION_ERROR');
  });

  it('two failures in a row → unread counts 2, bubble stays red', async () => {
    mockFetchOnce({ status: 403, body: { success: false, error: 'x' } });
    await handleMessage(makeEvent());

    mockFetchOnce({ status: 403, body: { success: false, error: 'x' } });
    await handleMessage(makeEvent());

    expect(stores.local[STORAGE_KEYS.UNREAD_COUNT]).toBe(2);
    expect(stores.local[STORAGE_KEYS.LAST_STATUS]).toBe('error');
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: BADGE_TEXT_ERROR });
    expect(chrome.action.setBadgeBackgroundColor).toHaveBeenLastCalledWith({
      color: BADGE_COLOR_ERROR,
    });
  });

  it('history is capped at HISTORY_CAP entries, newest first', async () => {
    for (let i = 0; i < HISTORY_CAP + 3; i++) {
      mockFetchOnce({ status: 200, body: { success: true } });
      await handleMessage(makeEvent({ name: `Person ${i}` }));
    }

    const history = stores.local[STORAGE_KEYS.HISTORY] as HistoryEntry[];
    expect(history).toHaveLength(HISTORY_CAP);
    expect(history[0].name).toBe(`Person ${HISTORY_CAP + 2}`);
    expect(history[HISTORY_CAP - 1].name).toBe('Person 3');
  });

  it('missing api_key in sync storage: records error without making fetch', async () => {
    stores = installStatefulStorage({});
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await handleMessage(makeEvent());

    expect(result.ok).toBe(false);
    expect(result.message).toBe('No api_key configured');
    expect(fetchSpy).not.toHaveBeenCalled();

    const history = stores.local[STORAGE_KEYS.HISTORY] as HistoryEntry[];
    expect(history[0].status).toBe('error');
    expect(stores.local[STORAGE_KEYS.UNREAD_COUNT]).toBe(1);
  });

  it('AbortError (timeout) classified as error with "Connection timed out"', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    globalThis.fetch = vi.fn().mockRejectedValueOnce(abortErr) as unknown as typeof fetch;

    const result = await handleMessage(makeEvent());

    expect(result.ok).toBe(false);
    expect(result.message).toBe('Connection timed out');

    const history = stores.local[STORAGE_KEYS.HISTORY] as HistoryEntry[];
    expect(history[0].status).toBe('error');
    expect(history[0].message).toBe('Connection timed out');
  });

  it('error followed by ok: bubble flips to green; highest_severity tracks worst-wins', async () => {
    mockFetchOnce({ status: 500, body: { success: false, error: 'boom' } });
    await handleMessage(makeEvent());

    mockFetchOnce({ status: 200, body: { success: true } });
    await handleMessage(makeEvent());

    // unread/highest_severity reflect cumulative errors (popup display)…
    expect(stores.local[STORAGE_KEYS.UNREAD_COUNT]).toBe(1);
    expect(stores.local[STORAGE_KEYS.HIGHEST_SEVERITY]).toBe('error');

    // …but the toolbar bubble reflects the LAST update.
    expect(stores.local[STORAGE_KEYS.LAST_STATUS]).toBe('ok');
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: BADGE_TEXT_OK });
    expect(chrome.action.setBadgeBackgroundColor).toHaveBeenLastCalledWith({
      color: BADGE_COLOR_OK,
    });
  });
});
