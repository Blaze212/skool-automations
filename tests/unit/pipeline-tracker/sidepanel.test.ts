// Spec 012 Phase 5 — side-panel shell (publishable build).
//
// Coverage:
//   1. renderUnsynced empty state.
//   2. renderUnsynced shows entries newest-first (capture order is append-only,
//      so we reverse-render for the panel).
//   3. Pagination boundary at 500 — older entries stay in storage but are NOT
//      in the DOM; the truncation note declares the gap.
//   4. D-rev-30 — row expand does NOT trigger any chrome.storage call
//      (recovered_html is never read by the side panel).
//   5. renderActivity renders HISTORY entries with status badges.
//   6. initSidePanel clears the unread counter on open (mirrors popup behavior).

/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  initSidePanel,
  renderActivity,
  renderUnsynced,
} from '../../../pipeline-tracker/src/sidepanel/sidepanel.ts';
import { _resetInitLatchForTests } from '../../../pipeline-tracker/src/storage.ts';
import {
  STORAGE_KEYS,
  type HistoryEntry,
  type OutboxEntry,
} from '../../../pipeline-tracker/src/types.ts';

interface LocalStore {
  [key: string]: unknown;
}

function installStatefulStorage(): LocalStore {
  const local: LocalStore = {};
  const read = (keys: string | string[] | undefined): LocalStore => {
    if (keys === undefined) return { ...local };
    const list = Array.isArray(keys) ? keys : [keys];
    const out: LocalStore = {};
    for (const k of list) if (k in local) out[k] = local[k];
    return out;
  };
  (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockImplementation(
    async (keys?: string | string[]) => read(keys),
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

function makeOutboxEntry(i: number, overrides: Partial<OutboxEntry['event']> = {}): OutboxEntry {
  return {
    history_id: `hist-${i}`,
    enqueued_at: new Date(2026, 4, 30, 10, 0, 0, i).toISOString(),
    attempts: 0,
    event: {
      api_key: 'pk_test',
      event_type: 'connection_request',
      date: '2026-05-30',
      name: `Person ${i}`,
      title: `Title ${i}`,
      linkedin_url: `https://www.linkedin.com/in/person${i}`,
      page_url: `https://www.linkedin.com/in/person${i}/`,
      message_text: '',
      source: 'selectors',
      ...overrides,
    },
  };
}

function makeHistoryEntry(i: number, status: HistoryEntry['status'] = 'pending'): HistoryEntry {
  return {
    id: `hist-${i}`,
    ts: new Date(2026, 4, 30, 10, 0, 0, i).toISOString(),
    status,
    event_type: 'connection_request',
    name: `Person ${i}`,
    page_url: `https://www.linkedin.com/in/person${i}/`,
    message: status === 'pending' ? 'Captured locally — needs sync' : 'Synced via app',
    warnings: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetInitLatchForTests();
  document.body.innerHTML = `
    <div id="settings-section"></div>
    <section id="unsynced-section"><div id="unsynced-list"></div><span id="unsynced-count"></span></section>
    <section id="activity-section"><div id="activity-list"></div></section>
    <div id="modal-root"></div>
  `;
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('side panel — renderUnsynced', () => {
  it('shows an empty-state message and blank count when outbox is empty', () => {
    const list = document.getElementById('unsynced-list') as HTMLElement;
    const count = document.getElementById('unsynced-count') as HTMLElement;
    const rendered = renderUnsynced(list, count, []);
    expect(rendered).toBe(0);
    expect(count.textContent).toBe('');
    expect(list.querySelector('.empty')?.textContent).toMatch(/No unsynced events/);
    expect(list.querySelectorAll('.row')).toHaveLength(0);
  });

  it('renders entries newest-first (capture order is append; panel reverses)', () => {
    const list = document.getElementById('unsynced-list') as HTMLElement;
    const count = document.getElementById('unsynced-count') as HTMLElement;
    const outbox = [makeOutboxEntry(1), makeOutboxEntry(2), makeOutboxEntry(3)];
    renderUnsynced(list, count, outbox);
    const names = Array.from(list.querySelectorAll('.name')).map((n) => n.textContent);
    expect(names).toEqual(['Person 3', 'Person 2', 'Person 1']);
    expect(count.textContent).toBe('3');
    expect(list.querySelector('.truncation-note')).toBeNull();
  });

  it('paginates at 500: older entries stay in storage but NOT in the DOM', () => {
    const list = document.getElementById('unsynced-list') as HTMLElement;
    const count = document.getElementById('unsynced-count') as HTMLElement;
    // 600 entries — exercises both the visible-window cap and the truncation note.
    const outbox = Array.from({ length: 600 }, (_, i) => makeOutboxEntry(i));
    const rendered = renderUnsynced(list, count, outbox);
    expect(rendered).toBe(500);
    expect(list.querySelectorAll('.row')).toHaveLength(500);
    expect(count.textContent).toBe('500 of 600');
    const note = list.querySelector('.truncation-note');
    expect(note?.textContent).toMatch(/Showing 500 of 600/);
    // Newest first means the head of the visible window is index 599, and the
    // last visible row is index 100 (600 − 500). Entries 0..99 stay in
    // storage but are off-screen — confirm by name.
    const names = Array.from(list.querySelectorAll('.name')).map((n) => n.textContent);
    expect(names[0]).toBe('Person 599');
    expect(names[names.length - 1]).toBe('Person 100');
  });

  it('row expand does NOT touch chrome.storage (D-rev-30: recovered_html stays in cold storage)', () => {
    const list = document.getElementById('unsynced-list') as HTMLElement;
    const count = document.getElementById('unsynced-count') as HTMLElement;
    renderUnsynced(list, count, [makeOutboxEntry(1, { source: 'ai-recovered' })]);
    (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockClear();

    const details = list.querySelector('details') as HTMLDetailsElement;
    details.open = true;
    details.dispatchEvent(new Event('toggle'));

    // The row already has its meta in the DOM at render time. Expanding it must
    // not trigger ANY storage read (no `recovered_html_<id>` lookup).
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
    // And the rendered meta must NOT contain recovered HTML markup.
    expect(details.querySelector('.meta')?.innerHTML ?? '').not.toMatch(/recovered/i);
  });

  it('renders the AI source badge when entry was recovered by the on-device model', () => {
    const list = document.getElementById('unsynced-list') as HTMLElement;
    const count = document.getElementById('unsynced-count') as HTMLElement;
    renderUnsynced(list, count, [makeOutboxEntry(1, { source: 'ai-recovered' })]);
    const labels = Array.from(list.querySelectorAll('.badge')).map((b) => b.textContent);
    expect(labels).toContain('AI');
  });

  it('refuses to render a clickable anchor for non-https/non-linkedin URLs (XSS guard)', () => {
    const list = document.getElementById('unsynced-list') as HTMLElement;
    const count = document.getElementById('unsynced-count') as HTMLElement;
    const hostile = [
      makeOutboxEntry(1, { linkedin_url: 'javascript:alert(1)' }),
      makeOutboxEntry(2, { linkedin_url: 'data:text/html,<script>alert(2)</script>' }),
      makeOutboxEntry(3, { linkedin_url: 'http://www.linkedin.com/in/foo' }), // http, not https
      makeOutboxEntry(4, { linkedin_url: 'https://evil.example.com/in/foo' }), // wrong host
      makeOutboxEntry(5, { linkedin_url: 'https://www.linkedin.com/in/jane' }), // good
    ];
    renderUnsynced(list, count, hostile);
    const anchors = Array.from(list.querySelectorAll('a'));
    // Only the well-formed https://www.linkedin.com row becomes an anchor.
    expect(anchors).toHaveLength(1);
    expect(anchors[0].href).toBe('https://www.linkedin.com/in/jane');
    expect(anchors[0].rel).toBe('noopener noreferrer');
    // The hostile values are still SHOWN (as plain text) so the user can see
    // what the extension captured — but they aren't a click target.
    expect(list.textContent).toMatch(/javascript:alert\(1\)/);
    expect(list.textContent).toMatch(/data:text\/html/);
  });
});

describe('side panel — renderActivity', () => {
  it('shows an empty-state message when history is empty', () => {
    const list = document.getElementById('activity-list') as HTMLElement;
    renderActivity(list, []);
    expect(list.querySelector('.empty')?.textContent).toMatch(/No recent activity/);
  });

  it('renders history entries with status badges', () => {
    const list = document.getElementById('activity-list') as HTMLElement;
    renderActivity(list, [makeHistoryEntry(1, 'ok'), makeHistoryEntry(2, 'error')]);
    const labels = Array.from(list.querySelectorAll('.badge')).map((b) => b.textContent);
    expect(labels).toEqual(expect.arrayContaining(['ok', 'error']));
  });
});

function seedFirstRunComplete(local: LocalStore): void {
  // Phase 6 — pre-seed first_run_completed so the modal does not block init.
  // Tests targeting the modal flow override this via their own local store
  // setup. Without this, every initSidePanel call would mount the modal and
  // hang (the close button is disabled until the user touches the toggle).
  local[STORAGE_KEYS.SETTINGS] = {
    ai_fallback_enabled: false,
    ai_model_downloaded: false,
    capture_message_bodies: false,
    first_run_completed: true,
  };
}

describe('side panel — initSidePanel', () => {
  it('reads outbox + history and clears the unread counter on open', async () => {
    const local = installStatefulStorage();
    seedFirstRunComplete(local);
    local[STORAGE_KEYS.OUTBOX] = [makeOutboxEntry(1)];
    local[STORAGE_KEYS.HISTORY] = [makeHistoryEntry(1, 'ok')];
    local[STORAGE_KEYS.UNREAD_COUNT] = 3;
    local[STORAGE_KEYS.HIGHEST_SEVERITY] = 'error';

    await initSidePanel();

    expect(local[STORAGE_KEYS.UNREAD_COUNT]).toBe(0);
    expect(local[STORAGE_KEYS.HIGHEST_SEVERITY]).toBe('ok');
    expect(
      (document.getElementById('unsynced-list') as HTMLElement).querySelectorAll('.row'),
    ).toHaveLength(1);
    expect(
      (document.getElementById('activity-list') as HTMLElement).querySelectorAll('.row'),
    ).toHaveLength(1);
  });

  it('sends drain_outbox to the SW after clearing so the publishable badge repaints', async () => {
    const local = installStatefulStorage();
    seedFirstRunComplete(local);
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    await initSidePanel();

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ kind: 'drain_outbox' });
  });

  it('renders the settings section above the events when first_run_completed is true', async () => {
    const local = installStatefulStorage();
    seedFirstRunComplete(local);

    await initSidePanel();

    // Settings is mounted from inside the modal-flow Promise chain; it's
    // fire-and-forget so we need to drain a macrotask for the
    // already-completed first-run path's synchronous return.
    await new Promise((r) => setTimeout(r, 0));

    const settingsRoot = document.getElementById('settings-section') as HTMLElement;
    expect(settingsRoot.querySelector('.settings-details')).not.toBeNull();
    // capture_message_bodies seeds to false here.
    const captureToggle = settingsRoot.querySelector(
      '#settings-capture-bodies',
    ) as HTMLInputElement;
    expect(captureToggle.checked).toBe(false);
  });

  it('renders events + clears badge BEFORE awaiting the first-run modal (defers nothing critical)', async () => {
    const local = installStatefulStorage();
    // First run — no settings seeded. Even though the modal will mount, the
    // events and badge-clear path must run first so the user never sees a
    // blank panel and the toolbar repaint isn't blocked by the disclosure.
    local[STORAGE_KEYS.OUTBOX] = [makeOutboxEntry(1)];
    local[STORAGE_KEYS.HISTORY] = [makeHistoryEntry(1, 'ok')];
    local[STORAGE_KEYS.UNREAD_COUNT] = 3;
    local[STORAGE_KEYS.HIGHEST_SEVERITY] = 'error';

    await initSidePanel();
    await new Promise((r) => setTimeout(r, 0));

    // Events rendered.
    expect(
      (document.getElementById('unsynced-list') as HTMLElement).querySelectorAll('.row'),
    ).toHaveLength(1);
    expect(
      (document.getElementById('activity-list') as HTMLElement).querySelectorAll('.row'),
    ).toHaveLength(1);
    // Badge cleared.
    expect(local[STORAGE_KEYS.UNREAD_COUNT]).toBe(0);
    expect(local[STORAGE_KEYS.HIGHEST_SEVERITY]).toBe('ok');
    // Modal still up (settings-section stays empty until the user closes it).
    expect(document.querySelector('.first-run-overlay')).not.toBeNull();
    expect(document.getElementById('settings-section')?.children.length).toBe(0);
  });

  it('mounts the settings section after the user closes the first-run modal', async () => {
    const local = installStatefulStorage();

    initSidePanel();
    await new Promise((r) => setTimeout(r, 0));

    const modal = document.querySelector('.first-run-overlay');
    const toggle = modal!.querySelector('#first-run-capture-bodies') as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    const closeBtn = modal!.querySelector('.first-run-close') as HTMLButtonElement;
    closeBtn.click();

    // Two macrotask yields — modal close → commit await → mountSettings.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(document.querySelector('.first-run-overlay')).toBeNull();
    expect(document.getElementById('settings-section')?.children.length).toBeGreaterThan(0);
    expect(
      (local[STORAGE_KEYS.SETTINGS] as { first_run_completed: boolean }).first_run_completed,
    ).toBe(true);
    expect(
      (local[STORAGE_KEYS.SETTINGS] as { capture_message_bodies: boolean }).capture_message_bodies,
    ).toBe(true);
  });

  it('falls back to default settings + still renders events when settingsStore.get throws', async () => {
    const local = installStatefulStorage();
    local[STORAGE_KEYS.OUTBOX] = [makeOutboxEntry(1)];
    // Make ONLY the settings-key read throw. Outbox + history reads stay clean.
    (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockImplementation(
      async (keys?: string | string[]) => {
        const list = Array.isArray(keys) ? keys : keys === undefined ? [] : [keys];
        if (list.includes(STORAGE_KEYS.SETTINGS)) {
          throw new Error('storage read failed');
        }
        const out: LocalStore = {};
        for (const k of list) if (k in local) out[k] = local[k];
        return out;
      },
    );

    await expect(initSidePanel()).resolves.toBeUndefined();
    expect(
      (document.getElementById('unsynced-list') as HTMLElement).querySelectorAll('.row'),
    ).toHaveLength(1);
  });
});
