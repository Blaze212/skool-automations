// Spec 012 Phase 7 / 015 C7 — background-side binding message routing.
//
// Coverage (single unified build — no BUILD_TARGET gate):
//   1. start_binding persists a pending binding + returns delivered count.
//   2. clear_binding removes the persisted binding.
//   3. wipe_unsynced clears outbox / pending history / recovered_html.
//   4. drain_outbox broadcasts new-events to connected app ports.
//   5. onConnectExternal + onMessageExternal listeners registered at module
//      load (delegate port-side validation to binding.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Snapshot the onConnectExternal / onMessageExternal listener registrations
// before vi.clearAllMocks in beforeEach blows them away — same pattern
// publishable-badge.test.ts uses for the alarm registrations.
const _initialConnectExternalCalls = [
  ...(chrome.runtime.onConnectExternal.addListener as ReturnType<typeof vi.fn>).mock.calls,
];
const _initialMessageExternalCalls = [
  ...(chrome.runtime.onMessageExternal.addListener as ReturnType<typeof vi.fn>).mock.calls,
];

import { handleMessage } from '../../../pipeline-tracker/src/background.ts';
import { _resetInitLatchForTests } from '../../../pipeline-tracker/src/storage.ts';
import {
  _clearAppPortsForTests,
  acceptAppPort,
  APP_PORT_NAME,
  ALLOWED_ORIGINS,
} from '../../../pipeline-tracker/src/binding.ts';
import {
  STORAGE_KEYS,
  type ExtensionBinding,
  type HistoryEntry,
  type OutboxEntry,
} from '../../../pipeline-tracker/src/types.ts';

interface LocalStore {
  [key: string]: unknown;
}

function installStatefulStorage(initial: LocalStore = {}): LocalStore {
  const local: LocalStore = { ...initial };
  (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockImplementation(
    async (keys?: string | string[] | null) => {
      if (keys === undefined || keys === null) return { ...local };
      const list = Array.isArray(keys) ? keys : [keys];
      const out: LocalStore = {};
      for (const k of list) if (k in local) out[k] = local[k];
      return out;
    },
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
  return local;
}

function makeConnectedPort(tabId = 42): chrome.runtime.Port {
  const listeners: Array<() => void> = [];
  return {
    name: APP_PORT_NAME,
    sender: {
      origin: Array.from(ALLOWED_ORIGINS)[0],
      tab: { id: tabId },
    } as chrome.runtime.MessageSender,
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: { addListener: vi.fn() },
    onDisconnect: {
      addListener: vi.fn((fn: () => void) => listeners.push(fn)),
    },
  } as unknown as chrome.runtime.Port;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetInitLatchForTests();
  _clearAppPortsForTests();
});

afterEach(() => {
  _clearAppPortsForTests();
});

describe('background — module-load registration', () => {
  it('registered an onConnectExternal listener at module load', () => {
    // Spec 015 C7 — the unified build always registers the externally_connectable
    // listeners at module load (no BUILD_TARGET gate anymore). The body just
    // delegates to acceptAppPort, which is tested independently in binding.test.ts.
    expect(typeof chrome.runtime.onConnectExternal.addListener).toBe('function');
    expect(_initialConnectExternalCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('registered an onMessageExternal listener at module load (Phase 9)', () => {
    expect(typeof chrome.runtime.onMessageExternal.addListener).toBe('function');
    expect(_initialMessageExternalCalls.length).toBeGreaterThanOrEqual(1);
  });
});

describe('background — start_binding routing', () => {
  it('persists pending binding + returns ok with delivered count', async () => {
    installStatefulStorage();

    const result = await handleMessage({ kind: 'start_binding' });

    expect(result).toMatchObject({ ok: true, delivered: 0 });
    const stored = (await chrome.storage.local.get(STORAGE_KEYS.BINDING)) as {
      [k: string]: ExtensionBinding;
    };
    expect(stored[STORAGE_KEYS.BINDING].status).toBe('pending');
    expect(typeof stored[STORAGE_KEYS.BINDING].token).toBe('string');
  });
});

function makeOutboxEntry(historyId: string): OutboxEntry {
  return {
    history_id: historyId,
    enqueued_at: '2026-05-31T00:00:00Z',
    attempts: 0,
    event: {
      api_key: 'pk_test',
      event_type: 'connection_request',
      date: '2026-05-31',
      name: 'Jane Doe',
      title: '',
      linkedin_url: 'https://www.linkedin.com/in/jane',
      page_url: 'https://www.linkedin.com/in/jane/',
      message_text: '',
    },
  };
}

function makeHistoryEntry(id: string, status: HistoryEntry['status'] = 'pending'): HistoryEntry {
  return {
    id,
    ts: '2026-05-31T00:00:00Z',
    status,
    event_type: 'connection_request',
    name: 'Jane Doe',
    page_url: 'https://www.linkedin.com/in/jane/',
    message: 'Queued — waiting to send',
    warnings: [],
  };
}

describe('background — clear_binding routing', () => {
  it('removes the persisted binding', async () => {
    const local = installStatefulStorage({
      [STORAGE_KEYS.BINDING]: {
        token: 'x',
        bound_at: 't',
        status: 'confirmed',
      } as ExtensionBinding,
    });

    const result = await handleMessage({ kind: 'clear_binding' });

    expect(result).toEqual({ ok: true });
    expect(local[STORAGE_KEYS.BINDING]).toBeUndefined();
  });
});

describe('background — wipe_unsynced routing', () => {
  it('full wipe: clears outbox, matching pending history, and all recovered_html keys', async () => {
    const local = installStatefulStorage({
      [STORAGE_KEYS.OUTBOX]: [makeOutboxEntry('h-1'), makeOutboxEntry('h-2')],
      [STORAGE_KEYS.HISTORY]: [
        makeHistoryEntry('h-1', 'pending'),
        makeHistoryEntry('h-2', 'pending'),
        makeHistoryEntry('h-3', 'ok'),
      ],
      'recovered_html_h-1': '<div>a</div>',
      'recovered_html_h-2': '<div>b</div>',
    });

    const result = await handleMessage({ kind: 'wipe_unsynced' });

    expect(result).toMatchObject({
      ok: true,
      wipedOutbox: 2,
      wipedRecoveredHtml: 2,
      wipedHistoryPending: 2,
    });
    expect(local[STORAGE_KEYS.OUTBOX]).toEqual([]);
    const remaining = local[STORAGE_KEYS.HISTORY] as HistoryEntry[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('h-3');
    expect(local['recovered_html_h-1']).toBeUndefined();
    expect(local['recovered_html_h-2']).toBeUndefined();
  });

  it('orphan recovered_html is wiped even when outbox is empty', async () => {
    const local = installStatefulStorage({
      recovered_html_orphan: '<div>leftover</div>',
    });

    const result = await handleMessage({ kind: 'wipe_unsynced' });

    expect(result).toMatchObject({
      ok: true,
      wipedOutbox: 0,
      wipedRecoveredHtml: 1,
      wipedHistoryPending: 0,
    });
    expect(local['recovered_html_orphan']).toBeUndefined();
    // No outbox write when outbox was already empty.
    expect(chrome.storage.local.set).not.toHaveBeenCalledWith(
      expect.objectContaining({ [STORAGE_KEYS.OUTBOX]: expect.anything() }),
    );
    // No history write when nothing was removed.
    expect(chrome.storage.local.set).not.toHaveBeenCalledWith(
      expect.objectContaining({ [STORAGE_KEYS.HISTORY]: expect.anything() }),
    );
  });

  it('non-pending history rows survive even when their id matches an outbox entry', async () => {
    const local = installStatefulStorage({
      [STORAGE_KEYS.OUTBOX]: [makeOutboxEntry('h-1')],
      [STORAGE_KEYS.HISTORY]: [
        makeHistoryEntry('h-1', 'pending'), // matches outbox — removed
        makeHistoryEntry('h-1', 'ok'), // same id but status=ok — survives
        makeHistoryEntry('h-2', 'pending'), // pending, no outbox entry — survives
      ],
    });

    const result = await handleMessage({ kind: 'wipe_unsynced' });

    expect(result).toMatchObject({ ok: true, wipedHistoryPending: 1 });
    const remaining = local[STORAGE_KEYS.HISTORY] as HistoryEntry[];
    expect(remaining).toHaveLength(2);
    expect(remaining.some((h) => h.id === 'h-1' && h.status === 'ok')).toBe(true);
    expect(remaining.some((h) => h.id === 'h-2' && h.status === 'pending')).toBe(true);
  });

  it('empty store: returns all-zero counts, does not write outbox or history', async () => {
    installStatefulStorage();

    const result = await handleMessage({ kind: 'wipe_unsynced' });

    expect(result).toMatchObject({
      ok: true,
      wipedOutbox: 0,
      wipedRecoveredHtml: 0,
      wipedHistoryPending: 0,
    });
    expect(chrome.storage.local.set).not.toHaveBeenCalledWith(
      expect.objectContaining({ [STORAGE_KEYS.OUTBOX]: expect.anything() }),
    );
    expect(chrome.storage.local.set).not.toHaveBeenCalledWith(
      expect.objectContaining({ [STORAGE_KEYS.HISTORY]: expect.anything() }),
    );
  });
});

describe('background — drain_outbox publishable path: new-events broadcast', () => {
  it('broadcasts new-events to connected ports when outbox is non-empty', async () => {
    const local = installStatefulStorage({
      [STORAGE_KEYS.OUTBOX]: [{ history_id: 'h1', event: {}, enqueued_at: '', attempts: 0 }],
      [STORAGE_KEYS.BADGE_STATE]: { unreadCount: 0, highestSeverity: 'ok', lastStatus: 'ok' },
    });

    const port = makeConnectedPort(10);
    acceptAppPort(port);

    const result = await handleMessage({ kind: 'drain_outbox' });

    expect(result).toMatchObject({ ok: true });
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'new-events', count: 1 });
  });

  it('does not broadcast when no ports are connected', async () => {
    installStatefulStorage({
      [STORAGE_KEYS.OUTBOX]: [{ history_id: 'h1', event: {}, enqueued_at: '', attempts: 0 }],
      [STORAGE_KEYS.BADGE_STATE]: { unreadCount: 0, highestSeverity: 'ok', lastStatus: 'ok' },
    });

    const result = await handleMessage({ kind: 'drain_outbox' });

    expect(result).toMatchObject({ ok: true });
  });

  it('does not broadcast when the outbox is empty', async () => {
    installStatefulStorage({
      [STORAGE_KEYS.OUTBOX]: [],
      [STORAGE_KEYS.BADGE_STATE]: { unreadCount: 0, highestSeverity: 'ok', lastStatus: 'ok' },
    });

    const port = makeConnectedPort(10);
    acceptAppPort(port);

    await handleMessage({ kind: 'drain_outbox' });

    expect(port.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'new-events' }),
    );
  });
});
