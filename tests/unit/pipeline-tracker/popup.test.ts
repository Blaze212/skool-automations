// @vitest-environment jsdom

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initPopup, renderHistory } from '../../../pipeline-tracker/src/popup/popup.ts';
import { STORAGE_KEYS, type HistoryEntry } from '../../../pipeline-tracker/src/types.ts';

const POPUP_HTML_PATH = resolve(__dirname, '../../../pipeline-tracker/src/popup/popup.html');

interface Store {
  [key: string]: unknown;
}

function installStorage(initial: { local?: Store; sync?: Store } = {}): {
  local: Store;
  sync: Store;
} {
  const local: Store = { ...(initial.local ?? {}) };
  const sync: Store = { ...(initial.sync ?? {}) };

  const read = (store: Store, keys: string | string[] | undefined): Store => {
    if (keys === undefined) return { ...store };
    const list = Array.isArray(keys) ? keys : [keys];
    const out: Store = {};
    for (const k of list) {
      if (k in store) out[k] = store[k];
    }
    return out;
  };

  (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockImplementation(
    async (keys?: string | string[]) => read(local, keys),
  );
  (chrome.storage.local.set as ReturnType<typeof vi.fn>).mockImplementation(
    async (entries: Store) => {
      Object.assign(local, entries);
    },
  );
  (chrome.storage.sync.get as ReturnType<typeof vi.fn>).mockImplementation(
    async (keys?: string | string[]) => read(sync, keys),
  );
  (chrome.storage.sync.set as ReturnType<typeof vi.fn>).mockImplementation(
    async (entries: Store) => {
      Object.assign(sync, entries);
    },
  );

  return { local, sync };
}

function loadPopupDom(): void {
  // jsdom's parsing of <!doctype html> happens via innerHTML on documentElement
  const html = readFileSync(POPUP_HTML_PATH, 'utf-8');
  // Extract just the <body> contents for the test fixture
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/);
  document.body.innerHTML = bodyMatch ? bodyMatch[1] : '';
}

function makeEntry(over: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    ts: '2026-05-22T14:03:11Z',
    status: 'ok',
    event_type: 'connection_request',
    name: 'Jane Doe',
    page_url: 'https://www.linkedin.com/in/jane/',
    message: 'Logged',
    warnings: [],
    ...over,
  };
}

describe('popup renderHistory', () => {
  beforeEach(() => {
    loadPopupDom();
  });

  it('hides section when entries is empty', () => {
    renderHistory([]);
    expect((document.getElementById('history') as HTMLElement).style.display).toBe('none');
  });

  it('renders one row per entry with correct icon class', () => {
    renderHistory([
      makeEntry({ name: 'Jane Doe', status: 'error', message: 'Connection failed.' }),
      makeEntry({ name: 'John Smith', status: 'ok', message: 'Logged' }),
    ]);

    const rows = document.querySelectorAll('.history-entry');
    expect(rows).toHaveLength(2);

    const icons = document.querySelectorAll('.history-icon');
    expect(icons[0].className).toContain('error');
    expect(icons[0].textContent).toBe('⚠');
    expect(icons[1].className).toContain('ok');
    expect(icons[1].textContent).toBe('✓');

    expect(rows[0].textContent).toContain('Jane Doe');
    expect(rows[0].textContent).toContain('connection request');
    expect(rows[0].textContent).toContain('Connection failed.');
  });

  it('renders "missing: ..." for partial entries with warnings', () => {
    renderHistory([
      makeEntry({
        status: 'partial',
        message: 'Logged',
        warnings: ['payload missing: title', 'payload missing: company'],
      }),
    ]);

    const message = document.querySelector('.history-message') as HTMLElement;
    expect(message.textContent).toContain('missing');
    expect(message.textContent).toContain('payload missing: title');
    expect(message.textContent).toContain('payload missing: company');
  });

  it('renders "(unknown)" when name is empty', () => {
    renderHistory([makeEntry({ name: '' })]);
    const title = document.querySelector('.history-title') as HTMLElement;
    expect(title.textContent).toContain('(unknown)');
  });
});

describe('popup initPopup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadPopupDom();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resets unread counter on open without touching the toolbar bubble', async () => {
    installStorage({
      sync: { [STORAGE_KEYS.API_KEY]: 'pk_test' },
      local: {
        [STORAGE_KEYS.UNREAD_COUNT]: 3,
        [STORAGE_KEYS.HIGHEST_SEVERITY]: 'error',
        [STORAGE_KEYS.HISTORY]: [makeEntry({ status: 'error', message: 'boom' })],
      },
    });

    await initPopup();

    // Bubble reflects the *last update*, so opening the popup must NOT clear it.
    expect(chrome.action.setBadgeText).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      expect.objectContaining({
        [STORAGE_KEYS.UNREAD_COUNT]: 0,
        [STORAGE_KEYS.HIGHEST_SEVERITY]: 'ok',
      }),
    );
    // History stays rendered until user clicks Clear
    expect(document.querySelectorAll('.history-entry')).toHaveLength(1);
  });

  it('clear-history button empties the history list and storage', async () => {
    const stores = installStorage({
      sync: { [STORAGE_KEYS.API_KEY]: 'pk_test' },
      local: {
        [STORAGE_KEYS.HISTORY]: [makeEntry(), makeEntry({ name: 'Other' })],
      },
    });

    await initPopup();
    expect(document.querySelectorAll('.history-entry')).toHaveLength(2);

    (document.getElementById('clear-history-btn') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));

    expect(document.querySelectorAll('.history-entry')).toHaveLength(0);
    expect((document.getElementById('history') as HTMLElement).style.display).toBe('none');
    expect(stores.local[STORAGE_KEYS.HISTORY]).toEqual([]);
  });

  it('hides the history section when there are no entries', async () => {
    installStorage({
      sync: { [STORAGE_KEYS.API_KEY]: 'pk_test' },
    });

    await initPopup();

    expect((document.getElementById('history') as HTMLElement).style.display).toBe('none');
  });
});
