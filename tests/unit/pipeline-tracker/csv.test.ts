// Spec 012 Phase 11 — CSV export.
//
// Coverage:
//   escapeCell — plain value, comma, double-quote, newline, CR, CR+LF
//   buildCsv — header row present; columns in spec order
//   buildCsv — selectors row: recovered_html empty, message_text gated by flag
//   buildCsv — ai-recovered row: recovered_html from map; absent key → empty
//   buildCsv — empty outbox returns header-only
//   buildCsv — message_text empty when captureMessageBodies=false
//   getCsvFilename — format pipeline-YYYY-MM-DD.csv
//   handleMessage export_csv — reads outbox+settings, calls chrome.downloads.download
//   handleMessage export_csv — fetches recovered_html for ai-recovered rows only
//   handleMessage export_csv — data: URL encodes the CSV correctly

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildCsv,
  CSV_HEADERS,
  escapeCell,
  getCsvFilename,
} from '../../../pipeline-tracker/src/csv.ts';
import { handleMessage } from '../../../pipeline-tracker/src/background.ts';
import { _resetInitLatchForTests } from '../../../pipeline-tracker/src/storage.ts';
import { STORAGE_KEYS, type OutboxEntry } from '../../../pipeline-tracker/src/types.ts';

// ── helpers ──────────────────────────────────────────────────────────────────

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

function makeOutboxEntry(
  historyId: string,
  overrides: Partial<OutboxEntry['event']> = {},
): OutboxEntry {
  return {
    history_id: historyId,
    enqueued_at: '2026-05-31T10:00:00.000Z',
    attempts: 0,
    event: {
      api_key: 'pk_test',
      event_type: 'connection_request',
      date: '2026-05-31',
      name: 'Jane Doe',
      title: 'VP Engineering',
      profile_url: 'https://www.linkedin.com/in/janedoe',
      page_url: 'https://www.linkedin.com/in/janedoe/',
      message_text: 'Hi Jane, I would love to connect!',
      source: 'selectors',
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetInitLatchForTests();
});

// ── escapeCell ────────────────────────────────────────────────────────────────

describe('escapeCell', () => {
  it('returns plain value unchanged', () => {
    expect(escapeCell('hello')).toBe('hello');
  });

  it('wraps in quotes when value contains a comma', () => {
    expect(escapeCell('hello, world')).toBe('"hello, world"');
  });

  it('wraps and doubles inner double-quotes', () => {
    expect(escapeCell('say "hi"')).toBe('"say ""hi"""');
  });

  it('wraps when value contains a newline', () => {
    expect(escapeCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('wraps when value contains a carriage return', () => {
    expect(escapeCell('a\rb')).toBe('"a\rb"');
  });

  it('handles empty string', () => {
    expect(escapeCell('')).toBe('');
  });
});

// ── buildCsv ──────────────────────────────────────────────────────────────────

describe('buildCsv', () => {
  it('returns header-only CSV for empty outbox', () => {
    const csv = buildCsv([], {}, false);
    expect(csv).toBe(CSV_HEADERS.join(','));
  });

  it('header row matches spec column order', () => {
    const csv = buildCsv([], {}, false);
    const [header] = csv.split('\n');
    expect(header).toBe(
      'captured_at,name,title,profile_url,event_type,message_text,source,recovered_html',
    );
  });

  it('selectors row: recovered_html column is empty regardless of map', () => {
    const entry = makeOutboxEntry('h1', { source: 'selectors' });
    const csv = buildCsv([entry], { h1: '<div>test</div>' }, true);
    const rows = csv.split('\n');
    expect(rows).toHaveLength(2);
    // recovered_html is the last column — ends with ','  then empty
    expect(rows[1]).toMatch(/,selectors,$/);
  });

  it('ai-recovered row: recovered_html column populated from map', () => {
    const entry = makeOutboxEntry('h2', { source: 'ai-recovered', message_text: '' });
    const html = '<div class="msg">Hi</div>';
    const csv = buildCsv([entry], { h2: html }, false);
    const [, dataRow] = csv.split('\n');
    // The last column should be the escaped HTML
    expect(dataRow).toContain(escapeCell(html));
  });

  it('ai-recovered row: recovered_html empty when absent from map', () => {
    const entry = makeOutboxEntry('h3', { source: 'ai-recovered' });
    const csv = buildCsv([entry], {}, false);
    const [, dataRow] = csv.split('\n');
    expect(dataRow).toMatch(/,ai-recovered,$/);
  });

  it('message_text included when captureMessageBodies=true', () => {
    const entry = makeOutboxEntry('h4', { message_text: 'Hi Jane, I would love to connect!' });
    const csv = buildCsv([entry], {}, true);
    const [, dataRow] = csv.split('\n');
    expect(dataRow).toContain('Hi Jane, I would love to connect!');
  });

  it('message_text empty when captureMessageBodies=false', () => {
    const entry = makeOutboxEntry('h5', { message_text: 'Do not leak this' });
    const csv = buildCsv([entry], {}, false);
    const [, dataRow] = csv.split('\n');
    // message_text is column 6 (0-indexed 5). Splitting on comma won't work for
    // escaped values, so verify the raw text does NOT appear in the output.
    expect(dataRow).not.toContain('Do not leak this');
  });

  it('escapes commas and quotes in cell values', () => {
    const entry = makeOutboxEntry('h6', {
      name: 'Doe, Jane',
      title: 'VP, "Engineering"',
    });
    const csv = buildCsv([entry], {}, false);
    const [, dataRow] = csv.split('\n');
    expect(dataRow).toContain('"Doe, Jane"');
    expect(dataRow).toContain('"VP, ""Engineering"""');
  });

  it('produces one data row per outbox entry', () => {
    const entries = [makeOutboxEntry('a'), makeOutboxEntry('b'), makeOutboxEntry('c')];
    const csv = buildCsv(entries, {}, false);
    expect(csv.split('\n')).toHaveLength(4); // header + 3 rows
  });
});

// ── getCsvFilename ─────────────────────────────────────────────────────────────

describe('getCsvFilename', () => {
  it('formats as pipeline-YYYY-MM-DD.csv', () => {
    const d = new Date(2026, 4, 31); // May 31 2026
    expect(getCsvFilename(d)).toBe('pipeline-2026-05-31.csv');
  });

  it('zero-pads single-digit month and day', () => {
    const d = new Date(2026, 0, 5); // Jan 5 2026
    expect(getCsvFilename(d)).toBe('pipeline-2026-01-05.csv');
  });
});

// ── handleMessage export_csv — integration ────────────────────────────────────

describe('handleMessage export_csv', () => {
  it('calls chrome.downloads.download with a data: CSV URL', async () => {
    const entry = makeOutboxEntry('e1', { source: 'selectors' });
    installStatefulStorage({
      [STORAGE_KEYS.OUTBOX]: [entry],
      [STORAGE_KEYS.SETTINGS]: {
        capture_message_bodies: false,
        first_run_completed: true,
        ai_fallback_enabled: false,
        ai_model_downloaded: false,
      },
    });

    const result = await handleMessage({ kind: 'export_csv' });
    expect(result.ok).toBe(true);

    expect(chrome.downloads.download).toHaveBeenCalledOnce();
    const call = (chrome.downloads.download as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      url: string;
      filename: string;
    };
    expect(call.url).toMatch(/^data:text\/csv;charset=utf-8,/);
    expect(call.filename).toMatch(/^pipeline-\d{4}-\d{2}-\d{2}\.csv$/);

    // Decode and verify header
    const csv = decodeURIComponent(call.url.replace('data:text/csv;charset=utf-8,', ''));
    const [header] = csv.split('\n');
    expect(header).toBe(CSV_HEADERS.join(','));
  });

  it('reads recovered_html from storage for ai-recovered rows', async () => {
    const entry = makeOutboxEntry('e2', { source: 'ai-recovered' });
    const html = '<div>recovered</div>';
    installStatefulStorage({
      [STORAGE_KEYS.OUTBOX]: [entry],
      [STORAGE_KEYS.SETTINGS]: {
        capture_message_bodies: false,
        first_run_completed: true,
        ai_fallback_enabled: false,
        ai_model_downloaded: false,
      },
      ['recovered_html_e2']: html,
    });

    await handleMessage({ kind: 'export_csv' });

    const call = (chrome.downloads.download as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      url: string;
    };
    const csv = decodeURIComponent(call.url.replace('data:text/csv;charset=utf-8,', ''));
    expect(csv).toContain(escapeCell(html));
  });

  it('does NOT read recovered_html storage for selectors rows', async () => {
    const entry = makeOutboxEntry('e3', { source: 'selectors' });
    installStatefulStorage({
      [STORAGE_KEYS.OUTBOX]: [entry],
      [STORAGE_KEYS.SETTINGS]: {
        capture_message_bodies: false,
        first_run_completed: true,
        ai_fallback_enabled: false,
        ai_model_downloaded: false,
      },
      ['recovered_html_e3']: '<div>should not appear</div>',
    });

    await handleMessage({ kind: 'export_csv' });

    const call = (chrome.downloads.download as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      url: string;
    };
    const csv = decodeURIComponent(call.url.replace('data:text/csv;charset=utf-8,', ''));
    expect(csv).not.toContain('should not appear');
  });

  it('empty outbox produces header-only CSV download', async () => {
    installStatefulStorage({
      [STORAGE_KEYS.OUTBOX]: [],
      [STORAGE_KEYS.SETTINGS]: {
        capture_message_bodies: false,
        first_run_completed: true,
        ai_fallback_enabled: false,
        ai_model_downloaded: false,
      },
    });

    await handleMessage({ kind: 'export_csv' });

    const call = (chrome.downloads.download as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      url: string;
    };
    const csv = decodeURIComponent(call.url.replace('data:text/csv;charset=utf-8,', ''));
    expect(csv.split('\n')).toHaveLength(1);
    expect(csv).toBe(CSV_HEADERS.join(','));
  });
});
