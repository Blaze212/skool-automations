// Spec 016 D-016-5/6 — enqueueManualCapture wire invariant (CEO-review decision 1).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OutboxFullError,
  StorageQuotaExceededError,
  enqueueManualCapture,
  type ManualCaptureInput,
} from '../../../pipeline-tracker/src/storage.ts';
import { OUTBOX_CAP, STORAGE_KEYS } from '../../../pipeline-tracker/src/types.ts';
import type { OutboxEntry } from '../../../pipeline-tracker/src/types.ts';

interface Store {
  [key: string]: unknown;
}

function installStatefulStorage(onSet?: (items: Store) => void): { local: Store } {
  const local: Store = {};
  (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockImplementation(
    async (keys?: string | string[]) => {
      if (keys === undefined || keys === null) return { ...local };
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Store = {};
      for (const k of list) if (k in local) out[k] = local[k];
      return out;
    },
  );
  (chrome.storage.local.set as ReturnType<typeof vi.fn>).mockImplementation(
    async (entries: Store) => {
      if (onSet) onSet(entries);
      Object.assign(local, entries);
    },
  );
  (chrome.storage.local.remove as ReturnType<typeof vi.fn>).mockImplementation(
    async (keys: string | string[]) => {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) delete local[k];
    },
  );
  return { local };
}

const baseInput: ManualCaptureInput = {
  name: 'Jane Doe',
  title: 'Head of Growth',
  linkedin_url: 'https://github.com/jane',
  message_text: 'hi there',
  event_type: 'direct_message',
  page_url: 'https://example.com/jane',
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('enqueueManualCapture — wire invariant', () => {
  it('writes an outbox entry with the hard-coded manual-capture flags', async () => {
    const { local } = installStatefulStorage();
    const { historyId } = await enqueueManualCapture(baseInput);

    const outbox = local[STORAGE_KEYS.OUTBOX] as OutboxEntry[];
    expect(outbox).toHaveLength(1);
    const entry = outbox[0];

    expect(entry.history_id).toBe(historyId);
    expect(entry.scrape_confidence).toBe('high');
    expect(entry.needs_review).toBe(false);
    expect(entry.user_reviewed).toBe(true);

    expect(entry.event.api_key).toBe('');
    expect(entry.event.scrape_confidence).toBe('high');
    expect(entry.event.event_type).toBe('direct_message');
    expect(entry.event.name).toBe('Jane Doe');
    expect(entry.event.title).toBe('Head of Growth');
    expect(entry.event.linkedin_url).toBe('https://github.com/jane');
    expect(entry.event.message_text).toBe('hi there');
    expect(entry.event.page_url).toBe('https://example.com/jane');
    // date is today's YYYY-MM-DD
    expect(entry.event.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('NEVER persists a recovered_html_* key (decision 3)', async () => {
    const { local } = installStatefulStorage();
    await enqueueManualCapture(baseInput);
    const keys = Object.keys(local);
    expect(keys.some((k) => k.startsWith('recovered_html_'))).toBe(false);
    const outbox = local[STORAGE_KEYS.OUTBOX] as OutboxEntry[];
    expect('recovered_html' in outbox[0].event).toBe(false);
  });

  it('adds a pending history row keyed by the same history_id', async () => {
    const { local } = installStatefulStorage();
    const { historyId } = await enqueueManualCapture(baseInput);
    const history = local[STORAGE_KEYS.HISTORY] as { id: string; status: string }[];
    expect(history[0].id).toBe(historyId);
    expect(history[0].status).toBe('pending');
  });

  it('gives each capture a fresh, unique history_id', async () => {
    installStatefulStorage();
    const a = await enqueueManualCapture(baseInput);
    const b = await enqueueManualCapture(baseInput);
    expect(a.historyId).not.toBe(b.historyId);
  });

  it('defaults event_type from the dropdown value passed in', async () => {
    const { local } = installStatefulStorage();
    await enqueueManualCapture({ ...baseInput, event_type: 'connection_request' });
    const outbox = local[STORAGE_KEYS.OUTBOX] as OutboxEntry[];
    expect(outbox[0].event.event_type).toBe('connection_request');
  });
});

describe('enqueueManualCapture — wire-shape oracle (CEO decision 6 / Acceptance)', () => {
  const oraclePath = fileURLToPath(
    new URL('../../fixtures/pipeline-tracker/manual-capture-wire-oracle.json', import.meta.url),
  );
  const oracle = JSON.parse(readFileSync(oraclePath, 'utf8')).event as Record<string, unknown>;

  it('emits exactly the field set tracker-import consumes — no extra keys', async () => {
    const { local } = installStatefulStorage();
    await enqueueManualCapture({
      name: 'Jane Doe',
      title: 'Head of Growth',
      linkedin_url: 'https://github.com/jane',
      message_text: 'hi there',
      event_type: 'connection_request',
      page_url: 'https://example.com/jane',
    });
    const event = (local[STORAGE_KEYS.OUTBOX] as OutboxEntry[])[0].event as Record<string, unknown>;

    // No recovered_html / source / debug leak onto the wire event.
    expect(Object.keys(event).sort()).toEqual(Object.keys(oracle).sort());
    // Field-for-field match (date is dynamic — normalize to the oracle's value).
    expect({ ...event, date: oracle.date }).toEqual(oracle);
    expect(event.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('enqueueManualCapture — failure modes leave the card recoverable', () => {
  it('throws OutboxFullError at OUTBOX_CAP without writing (no eviction)', async () => {
    const full: OutboxEntry[] = Array.from({ length: OUTBOX_CAP }, (_, i) => ({
      history_id: `h${i}`,
      enqueued_at: new Date(2026, 0, 1).toISOString(),
      attempts: 0,
      event: { ...baseInput, api_key: '', date: '2026-01-01' } as OutboxEntry['event'],
    }));
    const { local } = installStatefulStorage();
    local[STORAGE_KEYS.OUTBOX] = full;

    await expect(enqueueManualCapture(baseInput)).rejects.toBeInstanceOf(OutboxFullError);
    // outbox unchanged — no oldest-entry eviction (would be data loss).
    expect((local[STORAGE_KEYS.OUTBOX] as OutboxEntry[]).length).toBe(OUTBOX_CAP);
  });

  it('propagates StorageQuotaExceededError from the underlying set', async () => {
    installStatefulStorage(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    await expect(enqueueManualCapture(baseInput)).rejects.toBeInstanceOf(StorageQuotaExceededError);
  });
});
