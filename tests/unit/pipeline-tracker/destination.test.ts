// Spec 012 Phase 4 — DestinationStrategy unit tests.
//
// Coverage:
//   1. AppSyncStrategy.onEventCaptured + drainNow are no-ops (publishable build
//      must not touch the outbox unless app.cmcareersystems.com pulls).
//   2. WebhookAutoPushStrategy.onEventCaptured triggers drain → fetch → resolve.
//   3. WebhookAutoPushStrategy.deliverEventDirect classifies webhook responses
//      the same way as drain (used by popup's Test connection button).
//
// The end-to-end drain loop (retry classification, staleness aging, FIFO order,
// badge transitions) is already covered by background.test.ts and the Phase 3
// e2e regression test in background-drain.e2e.test.ts. This file targets the
// strategy boundary specifically.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AppSyncStrategy,
  WebhookAutoPushStrategy,
  type Classified,
} from '../../../pipeline-tracker/src/destination.ts';
import {
  _resetInitLatchForTests,
  setOutboxAndHistory,
} from '../../../pipeline-tracker/src/storage.ts';
import {
  STORAGE_KEYS,
  type OutboxEntry,
  type PipelineEvent,
} from '../../../pipeline-tracker/src/types.ts';

function makeEvent(overrides: Partial<PipelineEvent> = {}): PipelineEvent {
  return {
    api_key: 'pk_test',
    event_type: 'connection_request',
    date: '2026-05-30',
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
  (chrome.storage.local.remove as ReturnType<typeof vi.fn>).mockImplementation(
    async (keys: string | string[]) => {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) delete local[k];
    },
  );
  (chrome.storage.sync.get as ReturnType<typeof vi.fn>).mockImplementation(
    async (keys?: string | string[]) => read(sync, keys),
  );
  return { local, sync };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetInitLatchForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AppSyncStrategy', () => {
  it('onEventCaptured does not touch the outbox or fetch', async () => {
    const { local } = installStatefulStorage();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const strategy = new AppSyncStrategy();
    const outboxBefore: OutboxEntry[] = [
      { history_id: 'h-1', event: makeEvent(), enqueued_at: new Date().toISOString(), attempts: 0 },
    ];
    await setOutboxAndHistory(outboxBefore, []);

    await strategy.onEventCaptured(makeEvent(), 'h-1');

    expect(fetchMock).not.toHaveBeenCalled();
    // Outbox untouched.
    expect(local[STORAGE_KEYS.OUTBOX]).toEqual(outboxBefore);
  });

  it('drainNow is a no-op', async () => {
    const { local } = installStatefulStorage();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const strategy = new AppSyncStrategy();
    const outboxBefore: OutboxEntry[] = [
      { history_id: 'h-1', event: makeEvent(), enqueued_at: new Date().toISOString(), attempts: 0 },
      {
        history_id: 'h-2',
        event: makeEvent({ name: 'Bob' }),
        enqueued_at: new Date().toISOString(),
        attempts: 0,
      },
    ];
    await setOutboxAndHistory(outboxBefore, []);

    await strategy.drainNow();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(local[STORAGE_KEYS.OUTBOX]).toEqual(outboxBefore);
  });
});

describe('WebhookAutoPushStrategy', () => {
  it('onEventCaptured drains pending outbox entries through the webhook', async () => {
    const { local } = installStatefulStorage();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
    });
    vi.stubGlobal('fetch', fetchMock);

    const resolved: Array<{ historyId: string | null; classified: Classified }> = [];
    const strategy = new WebhookAutoPushStrategy({
      resolveHistory: async (_e, classified, historyId) => {
        resolved.push({ historyId, classified });
      },
    });

    const entry: OutboxEntry = {
      history_id: 'h-cap-1',
      event: makeEvent(),
      enqueued_at: new Date().toISOString(),
      attempts: 0,
    };
    await setOutboxAndHistory([entry], []);

    await strategy.onEventCaptured(makeEvent(), 'h-cap-1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resolved).toEqual([
      {
        historyId: 'h-cap-1',
        classified: expect.objectContaining({ status: 'ok', message: 'Logged' }),
      },
    ]);
    expect(local[STORAGE_KEYS.OUTBOX]).toEqual([]);
  });

  it('deliverEventDirect bypasses outbox and returns webhook outcome inline', async () => {
    installStatefulStorage();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ warnings: ['title missing'] })),
    });
    vi.stubGlobal('fetch', fetchMock);

    const resolveHistory = vi.fn();
    const strategy = new WebhookAutoPushStrategy({ resolveHistory });

    const outcome = await strategy.deliverEventDirect(makeEvent());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(outcome.transientFailure).toBe(false);
    expect(outcome.classified).toEqual(
      expect.objectContaining({
        status: 'partial',
        message: 'Logged with warnings: title missing',
        warnings: ['title missing'],
        http_status: 200,
      }),
    );
    // Direct path does NOT enqueue or call resolveHistory — background.ts owns
    // that side-effect after the inline outcome returns.
    expect(resolveHistory).not.toHaveBeenCalled();
  });

  it('_resetDrainingForTests releases an acquired latch so subsequent drains run', async () => {
    const { local } = installStatefulStorage();
    // Two outbox entries so the second drain after reset has work to do.
    const entry1: OutboxEntry = {
      history_id: 'h-reset-1',
      event: makeEvent({ name: 'Alice' }),
      enqueued_at: new Date().toISOString(),
      attempts: 0,
    };
    const entry2: OutboxEntry = {
      history_id: 'h-reset-2',
      event: makeEvent({ name: 'Bob' }),
      enqueued_at: new Date().toISOString(),
      attempts: 0,
    };
    await setOutboxAndHistory([entry1, entry2], []);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
    });
    vi.stubGlobal('fetch', fetchMock);

    const strategy = new WebhookAutoPushStrategy({ resolveHistory: async () => undefined });

    // Force the in-progress latch via the same private field the production
    // code mutates — guards against the regression where _resetDrainingForTests
    // is silently changed to a no-op (the prior test only asserted no-throw).
    (strategy as unknown as { _draining: boolean })._draining = true;

    // With latch acquired, drainNow short-circuits — no fetch.
    await strategy.drainNow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(local[STORAGE_KEYS.OUTBOX]).toHaveLength(2);

    // Reset latch and drain again — both entries process.
    strategy._resetDrainingForTests();
    await strategy.drainNow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(local[STORAGE_KEYS.OUTBOX]).toEqual([]);
  });
});
