import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  drainOutbox,
  handleMessage,
  onMessageHandler,
} from '../../../pipeline-tracker/src/background.ts';

// Snapshot the alarm registration that happened as a module-load side effect
// of the background.ts import above. We capture it BEFORE any test runs so
// vi.clearAllMocks() in beforeEach hooks can't wipe these records out — they
// represent the one-time SW-startup behavior we want to assert against.
const _initialAlarmCreateCalls = [...(chrome.alarms.create as ReturnType<typeof vi.fn>).mock.calls];
const _initialAlarmListenerCalls = [
  ...(chrome.alarms.onAlarm.addListener as ReturnType<typeof vi.fn>).mock.calls,
];
import {
  BADGE_COLOR_ERROR,
  BADGE_COLOR_OK,
  BADGE_COLOR_PARTIAL,
  BADGE_TEXT_ERROR,
  BADGE_TEXT_OK,
  BADGE_TEXT_PARTIAL,
  HISTORY_CAP,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_STALE_AFTER_MS,
  STORAGE_KEYS,
  type HistoryEntry,
  type OutboxEntry,
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
});

function makeOutboxEntry(
  overrides: Partial<OutboxEntry> = {},
  eventOverrides: Partial<PipelineEvent> = {},
): OutboxEntry {
  return {
    history_id: overrides.history_id ?? `hid-${Math.random().toString(36).slice(2)}`,
    enqueued_at: overrides.enqueued_at ?? new Date().toISOString(),
    attempts: overrides.attempts ?? 0,
    event: {
      api_key: 'pk_test',
      event_type: 'connection_request',
      date: '2026-05-22',
      name: 'Jane Doe',
      title: 'CEO',
      linkedin_url: 'https://www.linkedin.com/in/jane',
      page_url: 'https://www.linkedin.com/in/jane/',
      message_text: '',
      ...eventOverrides,
    },
    ...overrides,
  };
}

function makePendingHistoryEntry(id: string): HistoryEntry {
  return {
    id,
    ts: new Date().toISOString(),
    status: 'pending',
    event_type: 'connection_request',
    name: 'Jane Doe',
    page_url: 'https://www.linkedin.com/in/jane/',
    message: 'Queued — waiting to send',
    warnings: [],
  };
}

describe('pipeline-tracker drainOutbox', () => {
  let stores: ReturnType<typeof installStatefulStorage>;

  beforeEach(() => {
    vi.clearAllMocks();
    stores = installStatefulStorage();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves pending row in place on 200 success (no duplicate row)', async () => {
    const hid = 'hid-1';
    stores.local[STORAGE_KEYS.OUTBOX] = [makeOutboxEntry({ history_id: hid })];
    stores.local[STORAGE_KEYS.HISTORY] = [makePendingHistoryEntry(hid)];

    mockFetchOnce({ status: 200, body: { success: true } });
    await drainOutbox();

    const history = stores.local[STORAGE_KEYS.HISTORY] as HistoryEntry[];
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe(hid);
    expect(history[0].status).toBe('ok');
    expect(history[0].message).toBe('Logged');

    expect(stores.local[STORAGE_KEYS.OUTBOX]).toEqual([]);
  });

  it('drains FIFO — oldest event delivered first', async () => {
    stores.local[STORAGE_KEYS.OUTBOX] = [
      makeOutboxEntry({ history_id: 'a' }, { name: 'Alice' }),
      makeOutboxEntry({ history_id: 'b' }, { name: 'Bob' }),
    ];
    stores.local[STORAGE_KEYS.HISTORY] = [
      makePendingHistoryEntry('b'),
      makePendingHistoryEntry('a'),
    ];

    const calls: string[] = [];
    globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string) as PipelineEvent;
      calls.push(body.name);
      return new Response('{"success":true}', { status: 200 });
    }) as unknown as typeof fetch;

    await drainOutbox();

    expect(calls).toEqual(['Alice', 'Bob']);
    expect(stores.local[STORAGE_KEYS.OUTBOX]).toEqual([]);
  });

  it('transient failure increments attempts but keeps row pending', async () => {
    const hid = 'hid-retry';
    stores.local[STORAGE_KEYS.OUTBOX] = [makeOutboxEntry({ history_id: hid, attempts: 0 })];
    stores.local[STORAGE_KEYS.HISTORY] = [makePendingHistoryEntry(hid)];

    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    globalThis.fetch = vi.fn().mockRejectedValueOnce(abortErr) as unknown as typeof fetch;

    await drainOutbox();

    const outbox = stores.local[STORAGE_KEYS.OUTBOX] as OutboxEntry[];
    expect(outbox).toHaveLength(1);
    expect(outbox[0].attempts).toBe(1);

    const history = stores.local[STORAGE_KEYS.HISTORY] as HistoryEntry[];
    expect(history[0].status).toBe('pending');
  });

  it('drops entry as error after max attempts on transient failure', async () => {
    const hid = 'hid-dropped';
    stores.local[STORAGE_KEYS.OUTBOX] = [
      makeOutboxEntry({ history_id: hid, attempts: OUTBOX_MAX_ATTEMPTS }),
    ];
    stores.local[STORAGE_KEYS.HISTORY] = [makePendingHistoryEntry(hid)];

    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    globalThis.fetch = vi.fn().mockRejectedValueOnce(abortErr) as unknown as typeof fetch;

    await drainOutbox();

    expect(stores.local[STORAGE_KEYS.OUTBOX]).toEqual([]);
    const history = stores.local[STORAGE_KEYS.HISTORY] as HistoryEntry[];
    expect(history[0].id).toBe(hid);
    expect(history[0].status).toBe('error');
    expect(history[0].message).toContain('Dropped after');
  });

  it('drops stale entries (> 7 days old) without fetching', async () => {
    const hid = 'hid-stale';
    const stale = new Date(Date.now() - OUTBOX_STALE_AFTER_MS - 1000).toISOString();
    stores.local[STORAGE_KEYS.OUTBOX] = [makeOutboxEntry({ history_id: hid, enqueued_at: stale })];
    stores.local[STORAGE_KEYS.HISTORY] = [makePendingHistoryEntry(hid)];

    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await drainOutbox();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stores.local[STORAGE_KEYS.OUTBOX]).toEqual([]);
    const history = stores.local[STORAGE_KEYS.HISTORY] as HistoryEntry[];
    expect(history[0].status).toBe('error');
    expect(history[0].message).toContain('7 days');
  });

  it('hard failure (4xx) resolves pending row to error and removes from outbox', async () => {
    const hid = 'hid-403';
    stores.local[STORAGE_KEYS.OUTBOX] = [makeOutboxEntry({ history_id: hid })];
    stores.local[STORAGE_KEYS.HISTORY] = [makePendingHistoryEntry(hid)];

    mockFetchOnce({
      status: 403,
      body: { success: false, error: 'Unknown api_key', code: 'ACCESS_DENIED' },
    });

    await drainOutbox();

    expect(stores.local[STORAGE_KEYS.OUTBOX]).toEqual([]);
    const history = stores.local[STORAGE_KEYS.HISTORY] as HistoryEntry[];
    expect(history[0].id).toBe(hid);
    expect(history[0].status).toBe('error');
    expect(history[0].code).toBe('ACCESS_DENIED');
  });

  it('drain_outbox message triggers a drain', async () => {
    const hid = 'hid-msg';
    stores.local[STORAGE_KEYS.OUTBOX] = [makeOutboxEntry({ history_id: hid })];
    stores.local[STORAGE_KEYS.HISTORY] = [makePendingHistoryEntry(hid)];

    mockFetchOnce({ status: 200, body: { success: true } });

    const result = await handleMessage({ kind: 'drain_outbox' });
    expect(result.ok).toBe(true);
    expect(stores.local[STORAGE_KEYS.OUTBOX]).toEqual([]);
  });
});

describe('pipeline-tracker keep-alive alarm — Chrome docs compliance', () => {
  // Chrome docs (https://developer.chrome.com/docs/extensions/reference/api/alarms):
  //   "For installed extensions, anything less than 1 minute is treated as 1 minute."
  // So periodInMinutes < 1 is silently clamped in production. Asserting >= 1
  // here guarantees we ship a value that actually matches what Chrome will run.
  it('registers a recurring alarm with periodInMinutes >= 1 (Chrome production minimum)', () => {
    const keepAliveCall = _initialAlarmCreateCalls.find(
      (c) => c[0] === 'pipeline-tracker-keep-alive',
    );
    expect(keepAliveCall).toBeDefined();
    const opts = keepAliveCall![1] as { periodInMinutes?: number; delayInMinutes?: number };
    expect(opts.periodInMinutes).toBeGreaterThanOrEqual(1);
    expect(opts.delayInMinutes).toBeGreaterThanOrEqual(1);
  });

  it('registers an onAlarm listener (required for the SW to react to alarm fires)', () => {
    expect(_initialAlarmListenerCalls.length).toBeGreaterThan(0);
  });
});

describe('pipeline-tracker onMessageHandler — unhandled rejection hardening', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installStatefulStorage();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Regression: previously the listener was `void handleMessage(msg).then(sendResponse)`
  // with no .catch. If handleMessage rejected, sendResponse was never called →
  // the content script's await rejected with "message port closed" → and the SW
  // could be left in a state where Chrome stops auto-reviving it. The wrapper
  // must always call sendResponse so the channel closes cleanly.
  it('always calls sendResponse, even when handleMessage rejects', async () => {
    // Force handleMessage to reject by making chrome.storage.sync.get throw.
    (chrome.storage.sync.get as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('storage gone');
    });

    const sendResponse = vi.fn();
    onMessageHandler(makeEvent(), sendResponse);

    // Wait for the handler's promise to settle.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(sendResponse).toHaveBeenCalledTimes(1);
    const call = sendResponse.mock.calls[0][0] as { ok: boolean; message?: string };
    expect(call.ok).toBe(false);
    expect(call.message).toContain('storage gone');
  });

  it('calls sendResponse with the success result on the happy path', async () => {
    mockFetchOnce({ status: 200, body: { success: true } });

    const sendResponse = vi.fn();
    onMessageHandler(makeEvent(), sendResponse);

    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(sendResponse).toHaveBeenCalledTimes(1);
    const call = sendResponse.mock.calls[0][0] as { ok: boolean };
    expect(call.ok).toBe(true);
  });

  // Robustness: a misbehaving sendResponse (closed port, etc.) must not bubble
  // out as an unhandled rejection that would wedge the SW.
  it('swallows sendResponse exceptions instead of leaving an unhandled rejection', async () => {
    mockFetchOnce({ status: 200, body: { success: true } });

    const sendResponse = vi.fn().mockImplementation(() => {
      throw new Error('port closed');
    });

    // Should not throw or reject.
    onMessageHandler(makeEvent(), sendResponse);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(sendResponse).toHaveBeenCalledTimes(1);
  });
});

describe('pipeline-tracker background.handleMessage — last-update flip', () => {
  let stores: ReturnType<typeof installStatefulStorage>;

  beforeEach(() => {
    vi.clearAllMocks();
    stores = installStatefulStorage();
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
