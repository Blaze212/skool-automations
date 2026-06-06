// Spec 015 C7 — background service-worker message handling for the unified
// build. The webhook drain / keep-alive alarm / direct-event delivery paths
// were removed with the BUILD_TARGET split, so this file now covers the
// remaining surface: handleMessage routing for the non-binding kinds and the
// onMessageHandler unhandled-rejection hardening. Binding-message routing and
// the toolbar badge live in background-binding.test.ts / publishable-badge.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleMessage, onMessageHandler } from '../../../pipeline-tracker/src/background.ts';
import { _resetInitLatchForTests } from '../../../pipeline-tracker/src/storage.ts';
import { STORAGE_KEYS, type OutboxEntry } from '../../../pipeline-tracker/src/types.ts';

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

function makeOutboxEntry(historyId: string): OutboxEntry {
  return {
    history_id: historyId,
    enqueued_at: '2026-05-31T00:00:00Z',
    attempts: 0,
    scrape_confidence: 'high',
    needs_review: false,
    event: {
      api_key: 'pk_test',
      event_type: 'connection_request',
      date: '2026-05-31',
      name: 'Jane Doe',
      title: '',
      profile_url: 'https://www.linkedin.com/in/jane',
      page_url: 'https://www.linkedin.com/in/jane/',
      message_text: '',
      scrape_confidence: 'high',
    },
  };
}

describe('pipeline-tracker background.handleMessage — routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetInitLatchForTests();
    installStatefulStorage();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drain_outbox returns ok (pull-based — no autonomous webhook delivery)', async () => {
    const local = installStatefulStorage({
      [STORAGE_KEYS.OUTBOX]: [makeOutboxEntry('h-1')],
    });

    const result = await handleMessage({ kind: 'drain_outbox' });

    expect(result).toEqual({ ok: true });
    // Outbox is NOT drained by the SW — it waits for the app to pull.
    expect((local[STORAGE_KEYS.OUTBOX] as OutboxEntry[]).length).toBe(1);
  });

  it('export_csv builds a CSV and triggers a download', async () => {
    installStatefulStorage({ [STORAGE_KEYS.OUTBOX]: [makeOutboxEntry('h-1')] });

    const result = await handleMessage({ kind: 'export_csv' });

    expect(result).toEqual({ ok: true });
    expect(chrome.downloads.download).toHaveBeenCalledTimes(1);
    const arg = (chrome.downloads.download as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      url: string;
      filename: string;
    };
    expect(arg.url.startsWith('data:text/csv')).toBe(true);
    expect(arg.filename).toMatch(/\.csv$/);
  });

  it('unknown message kind returns ok:false', async () => {
    const result = await handleMessage({ kind: 'totally-unknown' } as never);
    expect(result.ok).toBe(false);
    expect(result.message).toBe('unknown message');
  });
});

describe('pipeline-tracker background.handleMessage — review actions (spec 015 B2)', () => {
  function flagged(id: string): OutboxEntry {
    return {
      history_id: id,
      enqueued_at: '2026-06-01T00:00:00Z',
      attempts: 0,
      scrape_confidence: 'low',
      needs_review: true,
      event: {
        api_key: 'pk_test',
        event_type: 'connection_request',
        date: '2026-06-01',
        name: 'Connect',
        title: '',
        profile_url: 'https://www.linkedin.com/feed/',
        page_url: 'https://www.linkedin.com/feed/',
        message_text: '',
        scrape_confidence: 'low',
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    _resetInitLatchForTests();
    installStatefulStorage();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('review_outbox_entry applies edits + marks reviewed', async () => {
    const local = installStatefulStorage({ [STORAGE_KEYS.OUTBOX]: [flagged('h-1')] });

    const result = await handleMessage({
      kind: 'review_outbox_entry',
      historyId: 'h-1',
      edits: { name: 'Jane Smith', title: 'CEO', profile_url: 'https://www.linkedin.com/in/jane' },
    });

    expect(result.ok).toBe(true);
    const entry = (local[STORAGE_KEYS.OUTBOX] as OutboxEntry[])[0];
    expect(entry.event.name).toBe('Jane Smith');
    expect(entry.user_reviewed).toBe(true);
  });

  it('delete_outbox_entry removes the entry (and its recovered_html + pending history)', async () => {
    const local = installStatefulStorage({
      [STORAGE_KEYS.OUTBOX]: [flagged('h-1'), flagged('h-2')],
      [STORAGE_KEYS.HISTORY]: [
        {
          id: 'h-1',
          ts: '2026-06-01T00:00:00Z',
          status: 'pending',
          event_type: 'connection_request',
          name: 'A',
          page_url: '',
          message: '',
          warnings: [],
        },
      ],
      ['recovered_html_h-1']: '<div>x</div>',
    });

    const result = await handleMessage({ kind: 'delete_outbox_entry', historyId: 'h-1' });

    expect(result.ok).toBe(true);
    const outbox = local[STORAGE_KEYS.OUTBOX] as OutboxEntry[];
    expect(outbox.map((e) => e.history_id)).toEqual(['h-2']);
    expect(local['recovered_html_h-1']).toBeUndefined();
    expect(local[STORAGE_KEYS.HISTORY]).toEqual([]);
  });

  it('delete_outbox_entry returns ok:false for an unknown id', async () => {
    installStatefulStorage({ [STORAGE_KEYS.OUTBOX]: [flagged('h-1')] });
    const result = await handleMessage({ kind: 'delete_outbox_entry', historyId: 'missing' });
    expect(result.ok).toBe(false);
  });

  it('review_outbox_entry returns ok:false for an unknown id', async () => {
    installStatefulStorage({ [STORAGE_KEYS.OUTBOX]: [flagged('h-1')] });
    const result = await handleMessage({
      kind: 'review_outbox_entry',
      historyId: 'missing',
      edits: { name: 'x', title: '', profile_url: '' },
    });
    expect(result.ok).toBe(false);
  });

  it('mark_outbox_reviewed approves the listed entries as-is', async () => {
    const local = installStatefulStorage({
      [STORAGE_KEYS.OUTBOX]: [flagged('a'), flagged('b')],
    });

    const result = await handleMessage({ kind: 'mark_outbox_reviewed', historyIds: ['a', 'b'] });

    expect(result.ok).toBe(true);
    const outbox = local[STORAGE_KEYS.OUTBOX] as OutboxEntry[];
    expect(outbox.every((e) => e.user_reviewed)).toBe(true);
  });
});

describe('pipeline-tracker onMessageHandler — unhandled rejection hardening', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetInitLatchForTests();
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
    // Force handleMessage to reject by making the very first storage read
    // (ensureInitialized) throw.
    (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('storage gone');
    });

    const sendResponse = vi.fn();
    onMessageHandler({ kind: 'drain_outbox' }, sendResponse);

    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(sendResponse).toHaveBeenCalledTimes(1);
    const call = sendResponse.mock.calls[0][0] as { ok: boolean; message?: string };
    expect(call.ok).toBe(false);
    expect(call.message).toContain('storage gone');
  });

  it('calls sendResponse with the success result on the happy path', async () => {
    const sendResponse = vi.fn();
    onMessageHandler({ kind: 'drain_outbox' }, sendResponse);

    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(sendResponse).toHaveBeenCalledTimes(1);
    const call = sendResponse.mock.calls[0][0] as { ok: boolean };
    expect(call.ok).toBe(true);
  });

  // Robustness: a misbehaving sendResponse (closed port, etc.) must not bubble
  // out as an unhandled rejection that would wedge the SW.
  it('swallows sendResponse exceptions instead of leaving an unhandled rejection', async () => {
    const sendResponse = vi.fn().mockImplementation(() => {
      throw new Error('port closed');
    });

    // Should not throw or reject.
    onMessageHandler({ kind: 'drain_outbox' }, sendResponse);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(sendResponse).toHaveBeenCalledTimes(1);
  });
});
