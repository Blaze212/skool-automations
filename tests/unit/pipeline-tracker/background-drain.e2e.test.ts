// Internal-build end-to-end regression test (spec 012 D-rev-31 / Phase 3).
//
// What this guards: the internal flow's contract end-to-end —
//   content enqueue → chrome.runtime.sendMessage('drain_outbox') →
//   background.onMessage listener → drainOutbox → fetch(webhook) →
//   recordResolved → HistoryEntry in place, outbox empty.
//
// Why it has to exist BEFORE Phase 4: Phase 4 wraps drainOutbox in a new
// DestinationStrategy interface for the publishable build. The internal flow
// must come out byte-identical. The webhook payload byte-equality assertion
// below is the regression guard — if Phase 4's refactor reshapes the body,
// the assertion breaks loudly.
//
// Existing background.test.ts exercises drainOutbox() directly; this file is
// strictly the chrome.runtime.sendMessage → listener → drain → webhook path,
// so a future refactor that moves drainOutbox behind a strategy still has to
// satisfy the same end-to-end behavior.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Importing background.ts triggers module-load side effects (onMessage listener
// registration, alarm setup, restoreBadgeOnStartup). The listener registration
// is what we route through below. restoreBadgeOnStartup fires a fire-and-forget
// drainOutbox() that briefly sets the module-level `_draining` flag — beforeEach
// calls _resetDrainingForTests() to make sure that flag can't leak into a test.
import { _resetDrainingForTests } from '../../../pipeline-tracker/src/background.ts';
import {
  BADGE_COLOR_ERROR,
  BADGE_COLOR_OK,
  BADGE_TEXT_ERROR,
  BADGE_TEXT_OK,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_STALE_AFTER_MS,
  STORAGE_KEYS,
  type HistoryEntry,
  type OutboxEntry,
  type PipelineEvent,
} from '../../../pipeline-tracker/src/types.ts';
import {
  _resetInitLatchForTests,
  setOutboxAndHistory,
} from '../../../pipeline-tracker/src/storage.ts';

// Capture the onMessage listener registered at module load BEFORE any
// vi.clearAllMocks() inside a test hook wipes the mock.calls record. The
// listener closure itself stays valid — only the call-record list is cleared.
type OnMessageListener = (
  msg: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => boolean;
const _onMessageListener = (chrome.runtime.onMessage.addListener as ReturnType<typeof vi.fn>).mock
  .calls[0]?.[0] as OnMessageListener | undefined;

if (!_onMessageListener) {
  throw new Error('background.ts did not register an onMessage listener at module load');
}

// --- Stateful storage harness ---

interface LocalStore {
  [k: string]: unknown;
}

function installStatefulStorage(initialSync: LocalStore = { [STORAGE_KEYS.API_KEY]: 'pk_test' }): {
  local: LocalStore;
  sync: LocalStore;
} {
  const local: LocalStore = {};
  const sync: LocalStore = { ...initialSync };

  const read = (store: LocalStore, keys?: string | string[]): LocalStore => {
    if (keys === undefined) return { ...store };
    const list = Array.isArray(keys) ? keys : [keys];
    const out: LocalStore = {};
    for (const k of list) if (k in store) out[k] = store[k];
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
  return { local, sync };
}

// --- Fetch capture ---

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  payload: PipelineEvent;
}

/**
 * Install a sequenced fetch mock. Each call consumes one entry; an Error entry
 * is thrown (simulates AbortError / network failure), a {status, body} entry
 * returns a Response. Throws if called more times than entries provided —
 * makes "POST happened more times than the test expected" visible immediately
 * instead of silently looping.
 */
function installFetchSequence(responses: Array<{ status: number; body?: unknown } | Error>): {
  calls: CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  let i = 0;
  globalThis.fetch = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
    const body = (init?.body as string) ?? '';
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
      body,
      payload: JSON.parse(body) as PipelineEvent,
    });
    const next = responses[i++];
    if (!next) {
      throw new Error(`fetch called more times than fixtures provided (call #${i})`);
    }
    if (next instanceof Error) throw next;
    const bodyStr = next.body === undefined ? '' : JSON.stringify(next.body);
    return new Response(bodyStr, {
      status: next.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls };
}

// --- Content-side enqueue (mirrors pipeline-tracker/src/content.ts) ---

// The real content.ts enqueuePendingEvent writes outbox + history via the same
// atomic setOutboxAndHistory helper we call here, so this stays in lock-step
// with the production code path it stands in for. Importing content.ts itself
// would drag in DOM-bound code and the linkedin-tracker card classes for no
// gain — what matters is that the SW sees the same storage shape.
interface EnqueueOptions {
  history_id?: string;
  enqueued_at?: string;
  eventOverrides?: Partial<PipelineEvent>;
}

async function contentEnqueue(opts: EnqueueOptions = {}): Promise<OutboxEntry> {
  const history_id = opts.history_id ?? `hid-${Math.random().toString(36).slice(2)}`;
  const enqueued_at = opts.enqueued_at ?? new Date().toISOString();
  const event: PipelineEvent = {
    api_key: '',
    event_type: 'connection_request',
    date: '2026-05-29',
    name: 'Jane Doe',
    title: 'VP Engineering',
    linkedin_url: 'https://www.linkedin.com/in/janedoe',
    page_url: 'https://www.linkedin.com/in/janedoe/',
    message_text: '',
    ...opts.eventOverrides,
  };
  const outboxEntry: OutboxEntry = { history_id, event, enqueued_at, attempts: 0 };
  const pendingHistory: HistoryEntry = {
    id: history_id,
    ts: enqueued_at,
    status: 'pending',
    event_type: event.event_type,
    name: event.name,
    page_url: event.page_url,
    message: 'Queued — waiting to send',
    warnings: [],
  };
  await setOutboxAndHistory([outboxEntry], [pendingHistory]);
  return outboxEntry;
}

// --- Drain trigger routed through the actual onMessage listener ---

function sendDrainViaListener(): Promise<{ ok: boolean; message?: string }> {
  return new Promise((resolve) => {
    const returned = _onMessageListener!({ kind: 'drain_outbox' }, {}, (response) => {
      resolve(response as { ok: boolean; message?: string });
    });
    // Background's listener returns true so Chrome holds the channel open for
    // the async sendResponse. If a future refactor drops that, sendResponse
    // would fire after the channel is closed and this promise would hang —
    // surface the regression immediately instead of letting the test time out.
    if (returned !== true) {
      throw new Error('onMessage listener returned non-true; async sendResponse will not fire');
    }
  });
}

// --- Tests ---

describe('pipeline-tracker internal-build e2e: content enqueue → SW drain → webhook (spec 012 D-rev-31)', () => {
  let stores: ReturnType<typeof installStatefulStorage>;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetInitLatchForTests();
    // Drop background.ts's module-level drain latch — the module-load
    // restoreBadgeOnStartup chain (and any prior test's drain) could leave
    // it stuck at true, causing this test's drainOutbox() to silently
    // early-return. Without this reset, the failure looks like
    // "fetch was never called" with no clear cause.
    _resetDrainingForTests();
    stores = installStatefulStorage();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The byte-identical regression guard. Phase 4 wraps drainOutbox behind
  // DestinationStrategy; the internal build's outbound webhook body has to
  // come out unchanged. JSON.stringify is order-sensitive, and background.ts
  // builds the payload via `{...event, api_key}` — that preserves the
  // event's insertion order with api_key landing in its original slot, which
  // pins the on-wire shape.
  it('on 200: posts byte-identical payload, resolves history in place, empties outbox', async () => {
    const entry = await contentEnqueue({
      history_id: 'hid-200',
      eventOverrides: { name: 'Jane Doe', title: 'VP Engineering' },
    });
    const { calls } = installFetchSequence([{ status: 200, body: { success: true } }]);

    const result = await sendDrainViaListener();

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    const req = calls[0];

    expect(req.url).toBe('http://localhost/test-pipeline-webhook');
    expect(req.method).toBe('POST');
    expect(req.headers['Content-Type']).toBe('application/json');

    // Byte-identical payload guard — fields in this exact order, no extras.
    // Any Phase 4 refactor that reshapes the body breaks here.
    expect(req.body).toBe(
      JSON.stringify({
        api_key: 'pk_test', // background.ts injects from sync storage
        event_type: 'connection_request',
        date: '2026-05-29',
        name: 'Jane Doe',
        title: 'VP Engineering',
        linkedin_url: 'https://www.linkedin.com/in/janedoe',
        page_url: 'https://www.linkedin.com/in/janedoe/',
        message_text: '',
      }),
    );

    // Outbox drained; history resolved in place under the same id (not a
    // duplicate row prepended).
    expect(stores.local[STORAGE_KEYS.OUTBOX]).toEqual([]);
    const history = stores.local[STORAGE_KEYS.HISTORY] as HistoryEntry[];
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe(entry.history_id);
    expect(history[0].status).toBe('ok');
    expect(history[0].message).toBe('Logged');
    expect(history[0].http_status).toBe(200);

    // Delivery bookkeeping cleared/refreshed atomically on success.
    expect(stores.local[STORAGE_KEYS.LAST_LOGGED_AT]).toEqual(expect.any(String));
    expect(stores.local[STORAGE_KEYS.LAST_ERROR]).toBeNull();

    // Badge updated — Phase 4's strategy split risks dropping this hook.
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: BADGE_TEXT_OK });
    expect(chrome.action.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: BADGE_COLOR_OK });
  });

  it('on 200 with warnings: classifies as partial; history carries the warnings array', async () => {
    await contentEnqueue({ history_id: 'hid-partial' });
    installFetchSequence([{ status: 200, body: { success: true, warnings: ['title missing'] } }]);

    await sendDrainViaListener();

    expect(stores.local[STORAGE_KEYS.OUTBOX]).toEqual([]);
    const history = stores.local[STORAGE_KEYS.HISTORY] as HistoryEntry[];
    expect(history[0].status).toBe('partial');
    expect(history[0].warnings).toEqual(['title missing']);
    expect(history[0].message).toContain('title missing');
  });

  it('on 400: hard failure — outbox drained, history resolved error with server message + code, exactly one POST', async () => {
    await contentEnqueue({ history_id: 'hid-400', eventOverrides: { name: '' } });
    const { calls } = installFetchSequence([
      {
        status: 400,
        body: { success: false, error: 'Missing required field: name', code: 'VALIDATION_ERROR' },
      },
    ]);

    await sendDrainViaListener();

    // Hard 4xx is NOT a transient failure — exactly one POST, no retry.
    // A regression that promoted 4xx to transient would still pass storage
    // assertions (entry eventually dropped after MAX_ATTEMPTS) but would
    // multiply webhook traffic. Pin the call count.
    expect(calls).toHaveLength(1);
    expect(stores.local[STORAGE_KEYS.OUTBOX]).toEqual([]);
    const history = stores.local[STORAGE_KEYS.HISTORY] as HistoryEntry[];
    expect(history[0].id).toBe('hid-400');
    expect(history[0].status).toBe('error');
    expect(history[0].http_status).toBe(400);
    expect(history[0].code).toBe('VALIDATION_ERROR');
    expect(history[0].message).toBe('Missing required field: name');
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: BADGE_TEXT_ERROR });
    expect(chrome.action.setBadgeBackgroundColor).toHaveBeenCalledWith({
      color: BADGE_COLOR_ERROR,
    });
  });

  it('on 500: hard failure — outbox drained, history resolved error, exactly one POST', async () => {
    await contentEnqueue({ history_id: 'hid-500' });
    const { calls } = installFetchSequence([
      { status: 500, body: { success: false, error: 'internal blew up' } },
    ]);

    await sendDrainViaListener();

    expect(calls).toHaveLength(1);
    expect(stores.local[STORAGE_KEYS.OUTBOX]).toEqual([]);
    const history = stores.local[STORAGE_KEYS.HISTORY] as HistoryEntry[];
    expect(history[0].id).toBe('hid-500');
    expect(history[0].status).toBe('error');
    expect(history[0].http_status).toBe(500);
    expect(history[0].message).toBe('internal blew up');
  });

  // effectiveSeverity() override (background.ts:67-71) — a 200 success on an
  // event that captured neither name NOR linkedin_url must still raise a red
  // bubble. Hides silent-capture failures from the server's "logged ok"
  // response. Existing background.test.ts:159 covers this for direct
  // handleMessage; we cover it here for the drain path so a Phase 4 strategy
  // split can't move classification away from effectiveSeverity and lose it.
  it('200 success but event has empty name AND linkedin_url: history forced to error (red bubble)', async () => {
    await contentEnqueue({
      history_id: 'hid-silent',
      eventOverrides: { name: '', linkedin_url: '' },
    });
    installFetchSequence([{ status: 200, body: { success: true } }]);

    await sendDrainViaListener();

    expect(stores.local[STORAGE_KEYS.OUTBOX]).toEqual([]);
    const history = stores.local[STORAGE_KEYS.HISTORY] as HistoryEntry[];
    expect(history[0].id).toBe('hid-silent');
    expect(history[0].status).toBe('error');
    expect(stores.local[STORAGE_KEYS.LAST_STATUS]).toBe('error');
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: BADGE_TEXT_ERROR });
    expect(chrome.action.setBadgeBackgroundColor).toHaveBeenLastCalledWith({
      color: BADGE_COLOR_ERROR,
    });
  });

  // Staleness aging (background.ts:322-335 + OUTBOX_STALE_AFTER_MS = 7d) is
  // load-bearing for the INTERNAL build only — spec line 102 explicitly notes
  // the publishable build removes it. Phase 4's shared base loop must keep it
  // for the internal strategy; this is the regression guard.
  it('stale entry (>7d old): dropped without fetch; history resolved with 7-day error', async () => {
    const stale = new Date(Date.now() - OUTBOX_STALE_AFTER_MS - 1000).toISOString();
    await contentEnqueue({ history_id: 'hid-stale', enqueued_at: stale });
    const { calls } = installFetchSequence([]);

    await sendDrainViaListener();

    expect(calls).toHaveLength(0); // no POST for stale entries
    expect(stores.local[STORAGE_KEYS.OUTBOX]).toEqual([]);
    const history = stores.local[STORAGE_KEYS.HISTORY] as HistoryEntry[];
    expect(history[0].id).toBe('hid-stale');
    expect(history[0].status).toBe('error');
    expect(history[0].message).toContain('7 days');
  });

  // Multi-entry FIFO via the listener route. The drain loop processes
  // outbox[0] each iteration; popOutboxHead removes by history_id (NOT by
  // index) so concurrent enqueues during drain can't shift the wrong entry
  // out. A Phase 4 strategy that swaps to LIFO, or pops by index after a
  // concurrent enqueue, would ship out-of-order POSTs or duplicate posts
  // (since the wrong entry's history_id stays in the outbox).
  it('multiple entries: drains in FIFO order via single listener trigger; outbox emptied', async () => {
    // Two pending histories so resolution can target them by id.
    const id1 = 'hid-fifo-1';
    const id2 = 'hid-fifo-2';
    const now1 = new Date(Date.now() - 2000).toISOString();
    const now2 = new Date(Date.now() - 1000).toISOString();
    const entry1: OutboxEntry = {
      history_id: id1,
      enqueued_at: now1,
      attempts: 0,
      event: {
        api_key: '',
        event_type: 'connection_request',
        date: '2026-05-29',
        name: 'Alice',
        title: '',
        linkedin_url: 'https://www.linkedin.com/in/alice',
        page_url: 'https://www.linkedin.com/in/alice/',
        message_text: '',
      },
    };
    const entry2: OutboxEntry = {
      history_id: id2,
      enqueued_at: now2,
      attempts: 0,
      event: {
        api_key: '',
        event_type: 'connection_request',
        date: '2026-05-29',
        name: 'Bob',
        title: '',
        linkedin_url: 'https://www.linkedin.com/in/bob',
        page_url: 'https://www.linkedin.com/in/bob/',
        message_text: '',
      },
    };
    const pending1: HistoryEntry = {
      id: id1,
      ts: now1,
      status: 'pending',
      event_type: 'connection_request',
      name: 'Alice',
      page_url: 'https://www.linkedin.com/in/alice/',
      message: 'Queued — waiting to send',
      warnings: [],
    };
    const pending2: HistoryEntry = {
      id: id2,
      ts: now2,
      status: 'pending',
      event_type: 'connection_request',
      name: 'Bob',
      page_url: 'https://www.linkedin.com/in/bob/',
      message: 'Queued — waiting to send',
      warnings: [],
    };
    // History prepends in capture order, so newest (id2) first.
    await setOutboxAndHistory([entry1, entry2], [pending2, pending1]);

    const { calls } = installFetchSequence([
      { status: 200, body: { success: true } },
      { status: 200, body: { success: true } },
    ]);

    await sendDrainViaListener();

    // FIFO: Alice (head) before Bob.
    expect(calls).toHaveLength(2);
    expect(calls[0].payload.name).toBe('Alice');
    expect(calls[1].payload.name).toBe('Bob');

    expect(stores.local[STORAGE_KEYS.OUTBOX]).toEqual([]);
    const history = stores.local[STORAGE_KEYS.HISTORY] as HistoryEntry[];
    // Both pending rows resolved in place (no duplicate rows prepended).
    const alice = history.find((h) => h.id === id1);
    const bob = history.find((h) => h.id === id2);
    expect(alice?.status).toBe('ok');
    expect(bob?.status).toBe('ok');
    expect(history).toHaveLength(2);
  });

  it('on transient network failure: increments attempts, keeps row at head, only one POST', async () => {
    const entry = await contentEnqueue({ history_id: 'hid-net-1' });
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    const { calls } = installFetchSequence([abortErr]);

    await sendDrainViaListener();

    // Drain attempted exactly once — drainOutbox stops at the first transient
    // failure so we don't hammer the webhook.
    expect(calls).toHaveLength(1);

    const outbox = stores.local[STORAGE_KEYS.OUTBOX] as OutboxEntry[];
    expect(outbox).toHaveLength(1);
    expect(outbox[0].history_id).toBe(entry.history_id);
    expect(outbox[0].attempts).toBe(1);

    // History row stays pending so the user knows the event is queued for retry.
    const history = stores.local[STORAGE_KEYS.HISTORY] as HistoryEntry[];
    expect(history[0].status).toBe('pending');

    // Delivery bookkeeping records the timeout.
    expect(stores.local[STORAGE_KEYS.LAST_ERROR]).toEqual(expect.any(String));
  });

  it('transient failure repeated to OUTBOX_MAX_ATTEMPTS: drops entry with error', async () => {
    const entry = await contentEnqueue({ history_id: 'hid-net-retry' });

    const mkAbort = (): Error => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      return e;
    };

    // Each drain trigger advances attempts by 1. Entry starts at 0:
    //   drain 1 → attempts=1, kept
    //   drain 2 → attempts=2, kept
    //   drain 3 → attempts=3, kept (updatedAttempts <= OUTBOX_MAX_ATTEMPTS)
    //   drain 4 → updatedAttempts=4 > OUTBOX_MAX_ATTEMPTS → dropped
    // This is what real production looks like: each onAlarm/onMessage drain
    // triggers one delivery attempt for the head entry, then stops on
    // transient failure.
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS + 1; i++) {
      installFetchSequence([mkAbort()]);
      await sendDrainViaListener();
    }

    expect(stores.local[STORAGE_KEYS.OUTBOX]).toEqual([]);
    const history = stores.local[STORAGE_KEYS.HISTORY] as HistoryEntry[];
    expect(history[0].id).toBe(entry.history_id);
    expect(history[0].status).toBe('error');
    expect(history[0].message).toContain('Dropped after');
    expect(history[0].message).toContain(`${OUTBOX_MAX_ATTEMPTS} retries`);
  });
});
