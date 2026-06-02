// Spec 012 Phase 9 — handleExternalMessage: ping + sync-pull.
//
// Coverage:
//   Origin validation — wrong origin → null (no response)
//   ping unbound        → {version, installed: true}
//   ping pending        → treated as unbound
//   ping bound+valid    → {version, installed, eventCount, unsyncedCount, bound: true}
//   ping bound+bad tkn  → {installed: true, bound: false}
//   ping bound+no tkn   → {installed: true, bound: false}
//   sync-pull no binding       → {error: 'NOT_BOUND'}
//   sync-pull pending binding  → {error: 'NOT_BOUND'}
//   sync-pull wrong token      → {error: 'NOT_BOUND'}
//   sync-pull empty outbox     → {rows: [], syncedIds: []}
//   sync-pull rows + syncedIds match outbox
//   sync-pull lazily attaches recovered_html when present
//   sync-pull does NOT add recovered_html field when absent
//   sync-pull idempotent — second call returns same data, no writes
//   sync-pull excludes already-acked entries (removed from outbox by Phase 10 sync-ack)

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handleExternalMessage } from '../../../pipeline-tracker/src/background-external.ts';
import { _resetInitLatchForTests } from '../../../pipeline-tracker/src/storage.ts';
import { APP_ORIGIN } from '../../../pipeline-tracker/src/binding.ts';
import {
  STORAGE_KEYS,
  type ExtensionBinding,
  type HistoryEntry,
  type OutboxEntry,
  type PipelineEvent,
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

function makeBinding(overrides: Partial<ExtensionBinding> = {}): ExtensionBinding {
  return {
    token: 'test-token-abc',
    bound_at: '2026-05-31T00:00:00Z',
    status: 'confirmed',
    ...overrides,
  };
}

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
      title: 'Engineer',
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
    message: 'Queued',
    warnings: [],
  };
}

const validSender: chrome.runtime.MessageSender = { origin: APP_ORIGIN };

beforeEach(() => {
  vi.clearAllMocks();
  _resetInitLatchForTests();
  (chrome.runtime.getManifest as ReturnType<typeof vi.fn>).mockReturnValue({ version: '1.0.0' });
});

// ─── Origin validation ──────────────────────────────────────────────────────

describe('handleExternalMessage — origin validation', () => {
  it('rejects wrong origin, returns null (no sendResponse)', async () => {
    installStatefulStorage();
    const result = await handleExternalMessage(
      { type: 'ping' },
      { origin: 'https://evil.example.com' },
    );
    expect(result).toBeNull();
  });

  it('rejects localhost on a non-allowed port number', async () => {
    installStatefulStorage();
    const result = await handleExternalMessage(
      { type: 'ping' },
      { origin: 'http://localhost:3000' },
    );
    expect(result).toBeNull();
  });

  it('accepts correct production origin, returns a response object', async () => {
    installStatefulStorage();
    const result = await handleExternalMessage({ type: 'ping' }, validSender);
    expect(result).not.toBeNull();
  });

  it('accepts localhost:5173 dev origin, returns a response object', async () => {
    installStatefulStorage();
    const result = await handleExternalMessage(
      { type: 'ping' },
      { origin: 'http://localhost:5173' },
    );
    expect(result).not.toBeNull();
  });

  it('returns null for unknown message type (valid origin)', async () => {
    installStatefulStorage();
    const result = await handleExternalMessage({ type: 'unknown-type' }, validSender);
    expect(result).toBeNull();
  });
});

// ─── ping ───────────────────────────────────────────────────────────────────

describe('handleExternalMessage — ping', () => {
  it('unbound (no binding key) → {version, installed: true}', async () => {
    installStatefulStorage();
    const result = await handleExternalMessage({ type: 'ping' }, validSender);
    expect(result).toEqual({ version: '1.0.0', installed: true });
  });

  it('binding pending (not confirmed) → treated as unbound', async () => {
    installStatefulStorage({
      [STORAGE_KEYS.BINDING]: makeBinding({ status: 'pending' }),
    });
    const result = await handleExternalMessage(
      { type: 'ping', bindingToken: 'test-token-abc' },
      validSender,
    );
    expect(result).toEqual({ version: '1.0.0', installed: true });
  });

  it('confirmed + valid token → full response with eventCount + unsyncedCount', async () => {
    installStatefulStorage({
      [STORAGE_KEYS.BINDING]: makeBinding(),
      [STORAGE_KEYS.OUTBOX]: [makeOutboxEntry('h-1'), makeOutboxEntry('h-2')],
      [STORAGE_KEYS.HISTORY]: [
        makeHistoryEntry('h-1', 'pending'),
        makeHistoryEntry('h-2', 'pending'),
        makeHistoryEntry('h-3', 'ok'),
      ],
    });
    const result = await handleExternalMessage(
      { type: 'ping', bindingToken: 'test-token-abc' },
      validSender,
    );
    expect(result).toEqual({
      version: '1.0.0',
      installed: true,
      eventCount: 3,
      unsyncedCount: 2,
      bound: true,
    });
  });

  it('confirmed + wrong token → {installed: true, bound: false} (version not revealed)', async () => {
    installStatefulStorage({
      [STORAGE_KEYS.BINDING]: makeBinding(),
    });
    const result = await handleExternalMessage(
      { type: 'ping', bindingToken: 'wrong-token' },
      validSender,
    );
    expect(result).toEqual({ installed: true, bound: false });
    expect(result).not.toHaveProperty('version');
  });

  it('confirmed + no token → {installed: true, bound: false}', async () => {
    installStatefulStorage({
      [STORAGE_KEYS.BINDING]: makeBinding(),
    });
    const result = await handleExternalMessage({ type: 'ping' }, validSender);
    expect(result).toEqual({ installed: true, bound: false });
  });

  it('empty outbox + empty history → eventCount:0, unsyncedCount:0', async () => {
    installStatefulStorage({
      [STORAGE_KEYS.BINDING]: makeBinding(),
    });
    const result = (await handleExternalMessage(
      { type: 'ping', bindingToken: 'test-token-abc' },
      validSender,
    )) as { eventCount: number; unsyncedCount: number };
    expect(result.eventCount).toBe(0);
    expect(result.unsyncedCount).toBe(0);
  });
});

// ─── sync-pull ──────────────────────────────────────────────────────────────

describe('handleExternalMessage — sync-pull', () => {
  it('no binding → {error: NOT_BOUND}', async () => {
    installStatefulStorage();
    const result = await handleExternalMessage(
      { type: 'sync-pull', bindingToken: 'any' },
      validSender,
    );
    expect(result).toEqual({ error: 'NOT_BOUND' });
  });

  it('pending binding → {error: NOT_BOUND}', async () => {
    installStatefulStorage({
      [STORAGE_KEYS.BINDING]: makeBinding({ status: 'pending' }),
    });
    const result = await handleExternalMessage(
      { type: 'sync-pull', bindingToken: 'test-token-abc' },
      validSender,
    );
    expect(result).toEqual({ error: 'NOT_BOUND' });
  });

  it('confirmed + wrong token → {error: NOT_BOUND}', async () => {
    installStatefulStorage({
      [STORAGE_KEYS.BINDING]: makeBinding(),
    });
    const result = await handleExternalMessage(
      { type: 'sync-pull', bindingToken: 'wrong-token' },
      validSender,
    );
    expect(result).toEqual({ error: 'NOT_BOUND' });
  });

  it('confirmed + correct token, empty outbox → {rows: [], syncedIds: []}', async () => {
    installStatefulStorage({
      [STORAGE_KEYS.BINDING]: makeBinding(),
    });
    const result = await handleExternalMessage(
      { type: 'sync-pull', bindingToken: 'test-token-abc' },
      validSender,
    );
    expect(result).toEqual({ rows: [], syncedIds: [] });
  });

  it('confirmed + correct token → rows and syncedIds match outbox entries', async () => {
    installStatefulStorage({
      [STORAGE_KEYS.BINDING]: makeBinding(),
      [STORAGE_KEYS.OUTBOX]: [makeOutboxEntry('h-1'), makeOutboxEntry('h-2')],
    });
    const result = (await handleExternalMessage(
      { type: 'sync-pull', bindingToken: 'test-token-abc' },
      validSender,
    )) as { rows: PipelineEvent[]; syncedIds: string[] };
    expect(result.syncedIds).toEqual(['h-1', 'h-2']);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].name).toBe('Jane Doe');
  });

  it('lazily attaches recovered_html when present in per-id keyed store', async () => {
    installStatefulStorage({
      [STORAGE_KEYS.BINDING]: makeBinding(),
      [STORAGE_KEYS.OUTBOX]: [makeOutboxEntry('h-1')],
      'recovered_html_h-1': '<div>profile html</div>',
    });
    const result = (await handleExternalMessage(
      { type: 'sync-pull', bindingToken: 'test-token-abc' },
      validSender,
    )) as { rows: PipelineEvent[]; syncedIds: string[] };
    expect(result.rows[0].recovered_html).toBe('<div>profile html</div>');
  });

  it('does NOT add recovered_html field when absent from keyed store', async () => {
    installStatefulStorage({
      [STORAGE_KEYS.BINDING]: makeBinding(),
      [STORAGE_KEYS.OUTBOX]: [makeOutboxEntry('h-1')],
    });
    const result = (await handleExternalMessage(
      { type: 'sync-pull', bindingToken: 'test-token-abc' },
      validSender,
    )) as { rows: PipelineEvent[]; syncedIds: string[] };
    expect(result.rows[0]).not.toHaveProperty('recovered_html');
  });

  it('only attaches recovered_html to rows that have it (mixed outbox)', async () => {
    installStatefulStorage({
      [STORAGE_KEYS.BINDING]: makeBinding(),
      [STORAGE_KEYS.OUTBOX]: [makeOutboxEntry('h-1'), makeOutboxEntry('h-2')],
      'recovered_html_h-1': '<div>html for h-1</div>',
    });
    const result = (await handleExternalMessage(
      { type: 'sync-pull', bindingToken: 'test-token-abc' },
      validSender,
    )) as { rows: PipelineEvent[]; syncedIds: string[] };
    expect(result.rows[0].recovered_html).toBe('<div>html for h-1</div>');
    expect(result.rows[1]).not.toHaveProperty('recovered_html');
  });

  it('idempotent — second call returns same rows without mutation', async () => {
    const local = installStatefulStorage({
      [STORAGE_KEYS.BINDING]: makeBinding(),
      [STORAGE_KEYS.OUTBOX]: [makeOutboxEntry('h-1'), makeOutboxEntry('h-2')],
    });
    const msg = { type: 'sync-pull' as const, bindingToken: 'test-token-abc' };
    const first = await handleExternalMessage(msg, validSender);
    const second = await handleExternalMessage(msg, validSender);
    expect(first).toEqual(second);
    // Outbox is unchanged — sync-pull must not write.
    expect((local[STORAGE_KEYS.OUTBOX] as OutboxEntry[]).length).toBe(2);
    expect(chrome.storage.local.set).not.toHaveBeenCalledWith(
      expect.objectContaining({ [STORAGE_KEYS.OUTBOX]: expect.anything() }),
    );
  });

  it('excludes already-acked entries (entries removed from outbox by Phase 10 sync-ack)', async () => {
    const local = installStatefulStorage({
      [STORAGE_KEYS.BINDING]: makeBinding(),
      [STORAGE_KEYS.OUTBOX]: [makeOutboxEntry('h-1'), makeOutboxEntry('h-2')],
    });
    const msg = { type: 'sync-pull' as const, bindingToken: 'test-token-abc' };

    // First pull sees both entries.
    const first = (await handleExternalMessage(msg, validSender)) as { syncedIds: string[] };
    expect(first.syncedIds).toEqual(['h-1', 'h-2']);

    // Simulate Phase 10 sync-ack removing h-1 from the outbox.
    local[STORAGE_KEYS.OUTBOX] = [makeOutboxEntry('h-2')];

    // Second pull — h-1 is gone; h-2 still present.
    const second = (await handleExternalMessage(msg, validSender)) as { syncedIds: string[] };
    expect(second.syncedIds).toEqual(['h-2']);
  });
});

// ─── sync-ack ───────────────────────────────────────────────────────────────

describe('handleExternalMessage — sync-ack', () => {
  it('no binding → {error: NOT_BOUND}', async () => {
    installStatefulStorage();
    const result = await handleExternalMessage(
      { type: 'sync-ack', bindingToken: 'any', syncedIds: ['h-1'] },
      validSender,
    );
    expect(result).toEqual({ error: 'NOT_BOUND' });
  });

  it('pending binding → {error: NOT_BOUND}', async () => {
    installStatefulStorage({
      [STORAGE_KEYS.BINDING]: makeBinding({ status: 'pending' }),
    });
    const result = await handleExternalMessage(
      { type: 'sync-ack', bindingToken: 'test-token-abc', syncedIds: ['h-1'] },
      validSender,
    );
    expect(result).toEqual({ error: 'NOT_BOUND' });
  });

  it('confirmed + wrong token → {error: NOT_BOUND}', async () => {
    installStatefulStorage({
      [STORAGE_KEYS.BINDING]: makeBinding(),
    });
    const result = await handleExternalMessage(
      { type: 'sync-ack', bindingToken: 'wrong-token', syncedIds: ['h-1'] },
      validSender,
    );
    expect(result).toEqual({ error: 'NOT_BOUND' });
  });

  it('confirmed + correct token, empty syncedIds → {ackedCount: 0}', async () => {
    installStatefulStorage({
      [STORAGE_KEYS.BINDING]: makeBinding(),
      [STORAGE_KEYS.OUTBOX]: [makeOutboxEntry('h-1')],
    });
    const result = await handleExternalMessage(
      { type: 'sync-ack', bindingToken: 'test-token-abc', syncedIds: [] },
      validSender,
    );
    expect(result).toEqual({ ackedCount: 0 });
  });

  it('confirmed + correct token → ackedCount equals ids found in outbox', async () => {
    installStatefulStorage({
      [STORAGE_KEYS.BINDING]: makeBinding(),
      [STORAGE_KEYS.OUTBOX]: [makeOutboxEntry('h-1'), makeOutboxEntry('h-2')],
      [STORAGE_KEYS.HISTORY]: [makeHistoryEntry('h-1'), makeHistoryEntry('h-2')],
    });
    const result = await handleExternalMessage(
      { type: 'sync-ack', bindingToken: 'test-token-abc', syncedIds: ['h-1', 'h-2'] },
      validSender,
    );
    expect(result).toEqual({ ackedCount: 2 });
  });

  it('unknown syncedIds silently ignored → {ackedCount: 0}', async () => {
    installStatefulStorage({
      [STORAGE_KEYS.BINDING]: makeBinding(),
      [STORAGE_KEYS.OUTBOX]: [makeOutboxEntry('h-1')],
      [STORAGE_KEYS.HISTORY]: [makeHistoryEntry('h-1')],
    });
    const result = await handleExternalMessage(
      { type: 'sync-ack', bindingToken: 'test-token-abc', syncedIds: ['h-unknown'] },
      validSender,
    );
    expect(result).toEqual({ ackedCount: 0 });
  });

  it('partial match: some known, some unknown → ackedCount reflects only known', async () => {
    installStatefulStorage({
      [STORAGE_KEYS.BINDING]: makeBinding(),
      [STORAGE_KEYS.OUTBOX]: [makeOutboxEntry('h-1'), makeOutboxEntry('h-2')],
      [STORAGE_KEYS.HISTORY]: [makeHistoryEntry('h-1'), makeHistoryEntry('h-2')],
    });
    const result = await handleExternalMessage(
      { type: 'sync-ack', bindingToken: 'test-token-abc', syncedIds: ['h-1', 'h-unknown'] },
      validSender,
    );
    expect(result).toEqual({ ackedCount: 1 });
  });

  it('removes matched outbox entries from storage', async () => {
    const local = installStatefulStorage({
      [STORAGE_KEYS.BINDING]: makeBinding(),
      [STORAGE_KEYS.OUTBOX]: [makeOutboxEntry('h-1'), makeOutboxEntry('h-2')],
      [STORAGE_KEYS.HISTORY]: [makeHistoryEntry('h-1'), makeHistoryEntry('h-2')],
    });
    await handleExternalMessage(
      { type: 'sync-ack', bindingToken: 'test-token-abc', syncedIds: ['h-1'] },
      validSender,
    );
    const outbox = local[STORAGE_KEYS.OUTBOX] as OutboxEntry[];
    expect(outbox).toHaveLength(1);
    expect(outbox[0].history_id).toBe('h-2');
  });

  it('updates history entry to status:ok and message:Synced via app', async () => {
    const local = installStatefulStorage({
      [STORAGE_KEYS.BINDING]: makeBinding(),
      [STORAGE_KEYS.OUTBOX]: [makeOutboxEntry('h-1'), makeOutboxEntry('h-2')],
      [STORAGE_KEYS.HISTORY]: [makeHistoryEntry('h-1'), makeHistoryEntry('h-2')],
    });
    await handleExternalMessage(
      { type: 'sync-ack', bindingToken: 'test-token-abc', syncedIds: ['h-1'] },
      validSender,
    );
    const history = local[STORAGE_KEYS.HISTORY] as HistoryEntry[];
    const h1 = history.find((e) => e.id === 'h-1');
    expect(h1?.status).toBe('ok');
    expect(h1?.message).toBe('Synced via app');
    // h-2 should be unchanged
    const h2 = history.find((e) => e.id === 'h-2');
    expect(h2?.status).toBe('pending');
  });

  it('removes recovered_html key for acked entry', async () => {
    const local = installStatefulStorage({
      [STORAGE_KEYS.BINDING]: makeBinding(),
      [STORAGE_KEYS.OUTBOX]: [makeOutboxEntry('h-1')],
      [STORAGE_KEYS.HISTORY]: [makeHistoryEntry('h-1')],
      'recovered_html_h-1': '<div>html</div>',
    });
    await handleExternalMessage(
      { type: 'sync-ack', bindingToken: 'test-token-abc', syncedIds: ['h-1'] },
      validSender,
    );
    expect(local['recovered_html_h-1']).toBeUndefined();
  });

  it('idempotent — second ack with same ids returns ackedCount: 0', async () => {
    installStatefulStorage({
      [STORAGE_KEYS.BINDING]: makeBinding(),
      [STORAGE_KEYS.OUTBOX]: [makeOutboxEntry('h-1')],
      [STORAGE_KEYS.HISTORY]: [makeHistoryEntry('h-1')],
    });
    const msg = { type: 'sync-ack' as const, bindingToken: 'test-token-abc', syncedIds: ['h-1'] };
    const first = await handleExternalMessage(msg, validSender);
    expect(first).toEqual({ ackedCount: 1 });
    // Second ack — h-1 is already gone from the outbox.
    const second = await handleExternalMessage(msg, validSender);
    expect(second).toEqual({ ackedCount: 0 });
  });

  it('refreshBadge dep is called on successful ack', async () => {
    installStatefulStorage({
      [STORAGE_KEYS.BINDING]: makeBinding(),
      [STORAGE_KEYS.OUTBOX]: [makeOutboxEntry('h-1')],
      [STORAGE_KEYS.HISTORY]: [makeHistoryEntry('h-1')],
    });
    const refreshBadge = vi.fn().mockResolvedValue(undefined);
    await handleExternalMessage(
      { type: 'sync-ack', bindingToken: 'test-token-abc', syncedIds: ['h-1'] },
      validSender,
      { refreshBadge },
    );
    expect(refreshBadge).toHaveBeenCalledOnce();
  });

  it('refreshBadge NOT called when NOT_BOUND is returned', async () => {
    installStatefulStorage();
    const refreshBadge = vi.fn().mockResolvedValue(undefined);
    await handleExternalMessage(
      { type: 'sync-ack', bindingToken: 'any', syncedIds: ['h-1'] },
      validSender,
      { refreshBadge },
    );
    expect(refreshBadge).not.toHaveBeenCalled();
  });

  it('mid-flight capture (D-rev-23): new event added after pull is not in syncedIds, survives ack', async () => {
    const local = installStatefulStorage({
      [STORAGE_KEYS.BINDING]: makeBinding(),
      [STORAGE_KEYS.OUTBOX]: [makeOutboxEntry('h-1'), makeOutboxEntry('h-2')],
      [STORAGE_KEYS.HISTORY]: [makeHistoryEntry('h-1'), makeHistoryEntry('h-2')],
    });

    // App pulled h-1 and h-2, then h-3 was captured mid-flight.
    // App only acks h-1 and h-2 — h-3 should survive.
    local[STORAGE_KEYS.OUTBOX] = [
      makeOutboxEntry('h-1'),
      makeOutboxEntry('h-2'),
      makeOutboxEntry('h-3'),
    ];
    (local[STORAGE_KEYS.HISTORY] as HistoryEntry[]).push(makeHistoryEntry('h-3'));

    await handleExternalMessage(
      { type: 'sync-ack', bindingToken: 'test-token-abc', syncedIds: ['h-1', 'h-2'] },
      validSender,
    );

    const outbox = local[STORAGE_KEYS.OUTBOX] as OutboxEntry[];
    expect(outbox).toHaveLength(1);
    expect(outbox[0].history_id).toBe('h-3');
  });
});
