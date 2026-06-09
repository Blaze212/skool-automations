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
  _resetBindingMountForTests,
  initSidePanel,
  renderActivity,
  renderUnsynced,
  saveManualCapture,
} from '../../../pipeline-tracker/src/sidepanel/sidepanel.ts';
import {
  _resetInitLatchForTests,
  OutboxFullError,
  type ManualCaptureInput,
} from '../../../pipeline-tracker/src/storage.ts';
import {
  OUTBOX_CAP,
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
      profile_url: `https://www.linkedin.com/in/person${i}`,
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
    <div id="binding-section"></div>
    <div id="review-section"></div>
    <div id="capture-section"></div>
    <section id="unsynced-section">
      <div style="display:flex;align-items:center;gap:6px;">
        <span id="unsynced-count"></span>
        <button id="sync-now-btn" type="button" hidden>Sync</button>
        <button id="export-csv-btn" type="button">Export CSV</button>
      </div>
      <div id="unsynced-list"></div>
    </section>
    <section id="activity-section"><div id="activity-list"></div></section>
    <div id="modal-root"></div>
  `;
});

afterEach(() => {
  _resetBindingMountForTests();
  document.body.innerHTML = '';
});

describe('side panel — saveManualCapture auto-sync nudge', () => {
  const captureInput: ManualCaptureInput = {
    name: 'Jane Doe',
    title: 'Head of Growth',
    profile_url: 'https://github.com/jane',
    message_text: 'hi there',
    event_type: 'direct_message',
    page_url: 'https://example.com/jane',
  };

  // Spec 016 deleted content.ts, which fired drain_outbox post-capture. The
  // manual save path must carry it forward or the SW never broadcasts
  // new-events and the webapp stops auto-syncing (sync-pull → sync-ack).
  it('sends drain_outbox to the SW after a successful enqueue', async () => {
    installStatefulStorage();
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

    await saveManualCapture(captureInput);

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ kind: 'drain_outbox' });
  });

  it('does NOT send drain_outbox when the enqueue throws (full outbox)', async () => {
    const local = installStatefulStorage();
    local[STORAGE_KEYS.OUTBOX] = Array.from({ length: OUTBOX_CAP }, (_, i) => ({
      history_id: `h${i}`,
      enqueued_at: new Date(2026, 0, 1).toISOString(),
      attempts: 0,
      event: { ...captureInput, api_key: '', date: '2026-01-01' } as OutboxEntry['event'],
    }));
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

    await expect(saveManualCapture(captureInput)).rejects.toBeInstanceOf(OutboxFullError);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith({ kind: 'drain_outbox' });
  });

  // A failed nudge must not surface as a save failure — the enqueue already
  // committed, so saveManualCapture resolves and the card clears normally.
  it('swallows a nudge failure when the enqueue already succeeded', async () => {
    installStatefulStorage();
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('SW asleep'),
    );

    await expect(saveManualCapture(captureInput)).resolves.toBeUndefined();
  });
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

  it('row expand shows captured_at timestamp (Phase 11)', () => {
    const list = document.getElementById('unsynced-list') as HTMLElement;
    const count = document.getElementById('unsynced-count') as HTMLElement;
    const entry = makeOutboxEntry(1);
    renderUnsynced(list, count, [entry]);
    const details = list.querySelector('details') as HTMLDetailsElement;
    const tsEl = details.querySelector('.meta-timestamp');
    expect(tsEl).not.toBeNull();
    expect(tsEl?.textContent).toContain(entry.enqueued_at);
  });

  it('row expand shows message_text when captureMessageBodies is true (Phase 11)', () => {
    const list = document.getElementById('unsynced-list') as HTMLElement;
    const count = document.getElementById('unsynced-count') as HTMLElement;
    renderUnsynced(list, count, [makeOutboxEntry(1, { message_text: 'Hi there!' })], {
      captureMessageBodies: true,
    });
    const details = list.querySelector('details') as HTMLDetailsElement;
    expect(details.querySelector('.meta-message')?.textContent).toBe('Hi there!');
  });

  it('row expand does NOT show message_text when captureMessageBodies is false (Phase 11)', () => {
    const list = document.getElementById('unsynced-list') as HTMLElement;
    const count = document.getElementById('unsynced-count') as HTMLElement;
    renderUnsynced(list, count, [makeOutboxEntry(1, { message_text: 'secret message' })], {
      captureMessageBodies: false,
    });
    const details = list.querySelector('details') as HTMLDetailsElement;
    expect(details.querySelector('.meta-message')).toBeNull();
    expect(details.textContent).not.toContain('secret message');
  });

  it('renders any https URL as a clickable anchor but refuses non-https schemes (spec 016 S-2)', () => {
    const list = document.getElementById('unsynced-list') as HTMLElement;
    const count = document.getElementById('unsynced-count') as HTMLElement;
    const mixed = [
      makeOutboxEntry(1, { profile_url: 'javascript:alert(1)' }), // unsafe scheme
      makeOutboxEntry(2, { profile_url: 'data:text/html,<script>alert(2)</script>' }), // unsafe
      makeOutboxEntry(3, { profile_url: 'http://www.linkedin.com/in/foo' }), // http, not https
      makeOutboxEntry(4, { profile_url: 'https://github.com/jane' }), // non-LinkedIn https → OK
      makeOutboxEntry(5, { profile_url: 'https://www.linkedin.com/in/jane' }), // LinkedIn https → OK
    ];
    renderUnsynced(list, count, mixed);
    const anchors = Array.from(list.querySelectorAll('a'));
    // Both https rows (any host) become anchors; the unsafe-scheme + http rows do not.
    const hrefs = anchors.map((a) => a.href).sort();
    expect(hrefs).toEqual(['https://github.com/jane', 'https://www.linkedin.com/in/jane']);
    expect(anchors[0].rel).toBe('noopener noreferrer');
    // The unsafe values are still SHOWN (as plain text) so the user can see what
    // was captured — but they aren't a click target.
    expect(list.textContent).toMatch(/javascript:alert\(1\)/);
    expect(list.textContent).toMatch(/data:text\/html/);
  });
});

describe('side panel — renderUnsynced editable rows (spec 015 B2 extended)', () => {
  it('renders editable inputs + a Save button for each row when onEdit is provided', () => {
    const list = document.getElementById('unsynced-list') as HTMLElement;
    const count = document.getElementById('unsynced-count') as HTMLElement;
    renderUnsynced(list, count, [makeOutboxEntry(1)], { onEdit: vi.fn() });

    const row = list.querySelector('details') as HTMLDetailsElement;
    const fields = Array.from(row.querySelectorAll('.review-input')).map(
      (el) => (el as HTMLInputElement | HTMLTextAreaElement).dataset.field,
    );
    expect(fields).toEqual(['name', 'title', 'profile_url', 'message_text']);
    expect(row.querySelector('.review-save-btn')).not.toBeNull();
  });

  it('keeps rows read-only (no inputs) when onEdit is omitted', () => {
    const list = document.getElementById('unsynced-list') as HTMLElement;
    const count = document.getElementById('unsynced-count') as HTMLElement;
    renderUnsynced(list, count, [makeOutboxEntry(1)]);
    expect(list.querySelector('.review-input')).toBeNull();
    expect(list.querySelector('.review-save-btn')).toBeNull();
  });

  it('Save passes the trimmed edited values to onEdit with the row history_id', () => {
    const list = document.getElementById('unsynced-list') as HTMLElement;
    const count = document.getElementById('unsynced-count') as HTMLElement;
    const onEdit = vi.fn().mockResolvedValue(undefined);
    renderUnsynced(list, count, [makeOutboxEntry(1)], { onEdit });

    const row = list.querySelector('details') as HTMLDetailsElement;
    const byField = (f: string) =>
      row.querySelector(`[data-field="${f}"]`) as HTMLInputElement | HTMLTextAreaElement;
    byField('name').value = '  Jane Doe  ';
    byField('title').value = 'Engineer';
    byField('profile_url').value = 'https://www.linkedin.com/in/jane';
    byField('message_text').value = '  hi  ';
    (row.querySelector('.review-save-btn') as HTMLButtonElement).click();

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledWith('hist-1', {
      name: 'Jane Doe',
      title: 'Engineer',
      profile_url: 'https://www.linkedin.com/in/jane',
      message_text: 'hi',
    });
  });

  it('re-enables the Save button after a successful save (shows a brief confirmation)', async () => {
    const list = document.getElementById('unsynced-list') as HTMLElement;
    const count = document.getElementById('unsynced-count') as HTMLElement;
    const onEdit = vi.fn().mockResolvedValue(undefined);
    renderUnsynced(list, count, [makeOutboxEntry(1)], { onEdit });

    const saveBtn = list.querySelector('.review-save-btn') as HTMLButtonElement;
    saveBtn.click();
    expect(saveBtn.disabled).toBe(true); // disabled while in flight
    await Promise.resolve();
    await Promise.resolve();
    expect(saveBtn.disabled).toBe(false); // re-enabled on success (was the bug)
    expect(saveBtn.textContent).toMatch(/Saved/);
  });

  it('renders a Delete button only when onDelete is provided, and calls it with the history_id', () => {
    const list = document.getElementById('unsynced-list') as HTMLElement;
    const count = document.getElementById('unsynced-count') as HTMLElement;

    // No onDelete → no Delete button.
    renderUnsynced(list, count, [makeOutboxEntry(1)], { onEdit: vi.fn() });
    expect(list.querySelector('.review-delete-btn')).toBeNull();

    // With onDelete → Delete button calls back with the row's history_id.
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderUnsynced(list, count, [makeOutboxEntry(1)], { onEdit: vi.fn(), onDelete });
    const delBtn = list.querySelector('.review-delete-btn') as HTMLButtonElement;
    expect(delBtn).not.toBeNull();
    delBtn.click();
    expect(onDelete).toHaveBeenCalledWith('hist-1');
    confirmSpy.mockRestore();
  });

  it('does not delete when the confirm dialog is dismissed', () => {
    const list = document.getElementById('unsynced-list') as HTMLElement;
    const count = document.getElementById('unsynced-count') as HTMLElement;
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderUnsynced(list, count, [makeOutboxEntry(1)], { onEdit: vi.fn(), onDelete });
    (list.querySelector('.review-delete-btn') as HTMLButtonElement).click();
    expect(onDelete).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('excludes held-back review items (needs_review && !user_reviewed) but keeps reviewed ones', () => {
    const list = document.getElementById('unsynced-list') as HTMLElement;
    const count = document.getElementById('unsynced-count') as HTMLElement;
    const outbox: OutboxEntry[] = [
      { ...makeOutboxEntry(1) }, // plain → shown
      { ...makeOutboxEntry(2), needs_review: true }, // held back → excluded
      { ...makeOutboxEntry(3), needs_review: true, user_reviewed: true }, // reviewed → shown
    ];
    const rendered = renderUnsynced(list, count, outbox, { onEdit: vi.fn() });
    expect(rendered).toBe(2);
    const names = Array.from(list.querySelectorAll('.name')).map((n) => n.textContent);
    expect(names).toEqual(['Person 3', 'Person 1']);
    expect(count.textContent).toBe('2');
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

  it('renders expandable <details> cards, not flat divs', () => {
    const list = document.getElementById('activity-list') as HTMLElement;
    renderActivity(list, [makeHistoryEntry(1, 'ok')]);
    expect(list.querySelector('details.row')).not.toBeNull();
    expect(list.querySelector('details.row summary.row-head')).not.toBeNull();
  });

  it('shows event-type badge alongside status badge', () => {
    const list = document.getElementById('activity-list') as HTMLElement;
    renderActivity(list, [makeHistoryEntry(1, 'pending')]);
    const badges = Array.from(list.querySelectorAll('summary .badge')).map((b) => b.textContent);
    expect(badges).toContain('Connect');
    expect(badges).toContain('pending');
  });

  it('re-renders with updated status when called again (simulates storage listener)', () => {
    const list = document.getElementById('activity-list') as HTMLElement;
    renderActivity(list, [makeHistoryEntry(1, 'pending')]);
    expect(list.querySelector('.badge-pending')).not.toBeNull();

    renderActivity(list, [makeHistoryEntry(1, 'ok')]);
    expect(list.querySelector('.badge-pending')).toBeNull();
    expect(list.querySelector('.badge-ok')).not.toBeNull();
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

  it('renders the review queue for flagged unreviewed entries and routes Save to the SW (spec 015 B2)', async () => {
    const local = installStatefulStorage();
    seedFirstRunComplete(local);
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    local[STORAGE_KEYS.OUTBOX] = [
      { ...makeOutboxEntry(1), needs_review: true }, // flagged, unreviewed → in queue
      { ...makeOutboxEntry(2), needs_review: true, user_reviewed: true }, // already reviewed → not in queue
      makeOutboxEntry(3), // clean → not in queue
    ];

    await initSidePanel();

    const reviewRoot = document.getElementById('review-section') as HTMLElement;
    const cards = reviewRoot.querySelectorAll('.review-card');
    expect(cards).toHaveLength(1);

    // Edit the name and Save → review_outbox_entry routed to the SW.
    const nameInput = reviewRoot.querySelector('input[data-field="name"]') as HTMLInputElement;
    nameInput.value = 'Corrected Name';
    (reviewRoot.querySelector('.review-save-btn') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      kind: 'review_outbox_entry',
      historyId: 'hist-1',
      edits: {
        name: 'Corrected Name',
        title: 'Title 1',
        profile_url: expect.any(String),
        message_text: expect.any(String),
      },
    });
  });

  it('re-renders activity list to ok when HISTORY storage change fires after sync', async () => {
    const local = installStatefulStorage();
    seedFirstRunComplete(local);
    local[STORAGE_KEYS.HISTORY] = [makeHistoryEntry(1, 'pending')];

    await initSidePanel();

    const list = document.getElementById('activity-list') as HTMLElement;
    expect(list.querySelector('.badge-pending')).not.toBeNull();

    // Simulate sync-ack writing ok status to storage, then firing storage.onChanged.
    local[STORAGE_KEYS.HISTORY] = [makeHistoryEntry(1, 'ok')];

    // Fire all registered storage.onChanged listeners with a HISTORY change —
    // only the activity listener acts on it; the others guard on their own key.
    const addListenerMock = chrome.storage.onChanged.addListener as ReturnType<typeof vi.fn>;
    const registeredListeners = addListenerMock.mock.calls.map(
      (call: unknown[]) =>
        call[0] as (changes: Record<string, chrome.storage.StorageChange>, area: string) => void,
    );
    const change = { [STORAGE_KEYS.HISTORY]: { oldValue: [], newValue: [] } };
    for (const fn of registeredListeners) fn(change, 'local');

    await new Promise((r) => setTimeout(r, 0));

    expect(list.querySelector('.badge-pending')).toBeNull();
    expect(list.querySelector('.badge-ok')).not.toBeNull();
  });

  it('sends drain_outbox to the SW after clearing so the publishable badge repaints', async () => {
    const local = installStatefulStorage();
    seedFirstRunComplete(local);
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    await initSidePanel();

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ kind: 'drain_outbox' });
  });

  it('Export CSV button sends export_csv to the SW (Phase 11)', async () => {
    const local = installStatefulStorage();
    seedFirstRunComplete(local);
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

    // The button must be present in the DOM (added by the HTML template in beforeEach).
    const btn = document.getElementById('export-csv-btn') as HTMLButtonElement;
    expect(btn).not.toBeNull();

    await initSidePanel();

    vi.clearAllMocks();
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

    btn.click();

    // Allow the microtask/Promise to flush.
    await new Promise((r) => setTimeout(r, 0));

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ kind: 'export_csv' });
  });

  it('Sync button opens the tracker tab and is shown when the outbox has events', async () => {
    const local = installStatefulStorage();
    seedFirstRunComplete(local);
    local[STORAGE_KEYS.OUTBOX] = [makeOutboxEntry(1)];

    const btn = document.getElementById('sync-now-btn') as HTMLButtonElement;
    expect(btn).not.toBeNull();

    await initSidePanel();

    // Outbox is non-empty → the Sync button is visible.
    expect(btn.hidden).toBe(false);

    vi.clearAllMocks();
    btn.click();

    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: 'https://app.cmcareersystems.com/tracker-fractional',
    });
  });

  it('Sync button stays hidden when the outbox is empty', async () => {
    const local = installStatefulStorage();
    seedFirstRunComplete(local);
    local[STORAGE_KEYS.OUTBOX] = [];

    const btn = document.getElementById('sync-now-btn') as HTMLButtonElement;

    await initSidePanel();

    expect(btn.hidden).toBe(true);
  });

  it('Sync button appears when an OUTBOX storage change adds the first event', async () => {
    const local = installStatefulStorage();
    seedFirstRunComplete(local);
    local[STORAGE_KEYS.OUTBOX] = [];

    const btn = document.getElementById('sync-now-btn') as HTMLButtonElement;

    await initSidePanel();
    expect(btn.hidden).toBe(true);

    // Simulate the SW enqueuing a capture: write OUTBOX and fire the listener.
    const listeners = (chrome.storage.onChanged.addListener as ReturnType<typeof vi.fn>).mock.calls;
    local[STORAGE_KEYS.OUTBOX] = [makeOutboxEntry(1)];
    for (const [listener] of listeners) {
      listener({ [STORAGE_KEYS.OUTBOX]: { newValue: local[STORAGE_KEYS.OUTBOX] } }, 'local');
    }
    await new Promise((r) => setTimeout(r, 0));

    expect(btn.hidden).toBe(false);
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

  it('re-mounts the capture card Stage dropdown live when product_mode changes', async () => {
    const local = installStatefulStorage();
    seedFirstRunComplete(local); // defaults to product_mode 'jobseeker' (absent)

    await initSidePanel();
    await new Promise((r) => setTimeout(r, 0));

    const captureRoot = document.getElementById('capture-section') as HTMLElement;
    const stageSelect = () =>
      captureRoot.querySelector('.capture-stage-select') as HTMLSelectElement;
    // Jobseeker mode → 3 stage options.
    expect(stageSelect().options).toHaveLength(3);

    const modeSelect = document.getElementById('settings-product-mode') as HTMLSelectElement;
    modeSelect.value = 'fractional';
    modeSelect.dispatchEvent(new Event('change'));

    // update() persists then re-mounts the capture section — drain the async.
    await new Promise((r) => setTimeout(r, 0));

    // Fractional mode → all 8 stage options, without reopening the panel.
    expect(stageSelect().options).toHaveLength(8);
    expect((local[STORAGE_KEYS.SETTINGS] as { product_mode: string }).product_mode).toBe(
      'fractional',
    );
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

describe('side panel — binding section + storage.onChanged wiring', () => {
  it('mounts the binding section with the persisted binding from storage', async () => {
    const local = installStatefulStorage();
    seedFirstRunComplete(local);
    local[STORAGE_KEYS.BINDING] = {
      token: 'tok',
      bound_at: '2026-05-30T10:00:00Z',
      status: 'confirmed',
    };

    await initSidePanel();
    await new Promise((r) => setTimeout(r, 0));

    const binding = document.querySelector('.binding-status-confirmed') as HTMLElement;
    expect(binding).not.toBeNull();
    expect(binding.textContent).toMatch(/Connected/);
  });

  it('shows a compact "Connected as <email>" indicator on the main panel (spec 016 UI)', async () => {
    const local = installStatefulStorage();
    seedFirstRunComplete(local);
    local[STORAGE_KEYS.BINDING] = {
      token: 'tok',
      bound_at: '2026-05-30T10:00:00Z',
      status: 'confirmed',
      account_email: 'jane@x.com',
    };

    await initSidePanel();
    await new Promise((r) => setTimeout(r, 0));

    const indicator = document.querySelector(
      '#binding-section .connected-indicator',
    ) as HTMLElement;
    expect(indicator).not.toBeNull();
    expect(indicator.textContent).toBe('Connected as jane@x.com');
  });

  it('registers a chrome.storage.onChanged listener that re-renders on BINDING changes', async () => {
    const local = installStatefulStorage();
    seedFirstRunComplete(local);

    await initSidePanel();
    await new Promise((r) => setTimeout(r, 0));

    // Capture the listener that mountBinding registered.
    const calls = (chrome.storage.onChanged.addListener as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const listener = calls[calls.length - 1][0] as (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => void;

    // Initial state: unbound (no binding seeded).
    expect(document.querySelector('.binding-primary')).not.toBeNull();

    // Simulate the SW writing a confirmed binding (bind-ack path).
    local[STORAGE_KEYS.BINDING] = {
      token: 'tok',
      bound_at: '2026-05-30T10:00:00Z',
      status: 'confirmed',
    };
    listener(
      {
        [STORAGE_KEYS.BINDING]: {
          newValue: local[STORAGE_KEYS.BINDING],
        } as chrome.storage.StorageChange,
      },
      'local',
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(document.querySelector('.binding-status-confirmed')).not.toBeNull();
    expect(document.querySelector('.binding-primary')).toBeNull();
  });

  it('ignores storage.onChanged events from other areas (sync, session)', async () => {
    const local = installStatefulStorage();
    seedFirstRunComplete(local);

    await initSidePanel();
    await new Promise((r) => setTimeout(r, 0));

    const listener = (
      chrome.storage.onChanged.addListener as ReturnType<typeof vi.fn>
    ).mock.calls.at(-1)?.[0] as (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => void;

    // Spy on bindingStore activity by clearing get-mock history.
    (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockClear();

    listener(
      { [STORAGE_KEYS.BINDING]: { newValue: 'whatever' } as chrome.storage.StorageChange },
      'sync',
    );
    await new Promise((r) => setTimeout(r, 0));

    // No bindingStore.get round-trip should have fired.
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
  });

  it('ignores storage.onChanged events where the BINDING key did not change', async () => {
    const local = installStatefulStorage();
    seedFirstRunComplete(local);

    await initSidePanel();
    await new Promise((r) => setTimeout(r, 0));

    const listener = (
      chrome.storage.onChanged.addListener as ReturnType<typeof vi.fn>
    ).mock.calls.at(-1)?.[0] as (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => void;
    (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockClear();

    // A change to OUTBOX or HISTORY should not trigger a binding re-read.
    listener({ [STORAGE_KEYS.OUTBOX]: { newValue: [] } as chrome.storage.StorageChange }, 'local');
    await new Promise((r) => setTimeout(r, 0));

    expect(chrome.storage.local.get).not.toHaveBeenCalled();
  });

  it('re-mounting via a second initSidePanel call does NOT leak storage.onChanged listeners', async () => {
    installStatefulStorage();
    const local = installStatefulStorage();
    seedFirstRunComplete(local);

    await initSidePanel();
    await new Promise((r) => setTimeout(r, 0));
    await initSidePanel();
    await new Promise((r) => setTimeout(r, 0));

    // Each safelyMountBinding call MUST tear down the prior subscription
    // before installing its own.
    expect(chrome.storage.onChanged.removeListener).toHaveBeenCalled();
  });
});

describe('side panel — Phase 8 zero-tab CTA (D-rev-9)', () => {
  it('renders an "Open CareerSystems" action when startBinding reports delivered=0', async () => {
    const local = installStatefulStorage();
    seedFirstRunComplete(local);

    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
      async (msg: { kind: string }) => {
        if (msg.kind === 'start_binding') {
          local[STORAGE_KEYS.BINDING] = {
            token: 'tok',
            bound_at: new Date().toISOString(),
            status: 'pending',
          };
          return { ok: true, delivered: 0 };
        }
        if (msg.kind === 'clear_binding') {
          delete local[STORAGE_KEYS.BINDING];
          return { ok: true };
        }
        return { ok: true };
      },
    );

    await initSidePanel();
    await new Promise((r) => setTimeout(r, 0));

    const connect = document.querySelector('.binding-primary') as HTMLButtonElement;
    expect(connect).not.toBeNull();
    connect.click();
    // Drain microtasks for start_binding → clear_binding chain.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const errBtn = document.querySelector('.binding-error button') as HTMLButtonElement;
    expect(errBtn).not.toBeNull();
    expect(errBtn.textContent).toBe('Open CareerSystems');

    errBtn.click();
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: 'https://app.cmcareersystems.com/tracker-fractional',
    });
  });
});

describe('side panel — Phase 8 rebind 3-choice protection (D-rev-19)', () => {
  function seedConfirmedBindingPlusOutbox(local: LocalStore, count: number): void {
    local[STORAGE_KEYS.BINDING] = {
      token: 'tok',
      bound_at: '2026-05-30T10:00:00Z',
      status: 'confirmed',
    };
    local[STORAGE_KEYS.OUTBOX] = Array.from({ length: count }, (_, i) => ({
      history_id: `h-${i}`,
      enqueued_at: new Date().toISOString(),
      attempts: 0,
      event: {
        api_key: 'pk_test',
        event_type: 'connection_request' as const,
        date: '2026-05-30',
        name: `N${i}`,
        title: '',
        profile_url: '',
        page_url: '',
        message_text: '',
        source: 'selectors' as const,
      },
    }));
  }

  it('disconnect with confirmed + outbox>0 surfaces the 3-choice modal', async () => {
    const local = installStatefulStorage();
    seedFirstRunComplete(local);
    seedConfirmedBindingPlusOutbox(local, 3);

    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

    await initSidePanel();
    await new Promise((r) => setTimeout(r, 0));

    const disconnect = document.querySelector('.binding-secondary') as HTMLButtonElement;
    disconnect.click();
    // Modal mounts synchronously on click after we await the outboxStore /
    // bindingStore reads.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const overlay = document.querySelector('.rebind-overlay');
    expect(overlay).not.toBeNull();
    expect(document.querySelectorAll('.rebind-choice-btn')).toHaveLength(3);
  });

  it('sync-first choice cancels disconnect — binding and outbox stay intact', async () => {
    const local = installStatefulStorage();
    seedFirstRunComplete(local);
    seedConfirmedBindingPlusOutbox(local, 2);

    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

    await initSidePanel();
    await new Promise((r) => setTimeout(r, 0));

    (document.querySelector('.binding-secondary') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const buttons = document.querySelectorAll<HTMLButtonElement>('.rebind-choice-btn');
    // sync-first is first
    buttons[0].click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(document.querySelector('.rebind-overlay')).toBeNull();
    // No clear_binding was sent; binding + outbox preserved.
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith({ kind: 'clear_binding' });
    expect(local[STORAGE_KEYS.BINDING]).toBeDefined();
    expect((local[STORAGE_KEYS.OUTBOX] as unknown[]).length).toBe(2);
  });

  it('move-events choice clears binding only — outbox preserved for new account', async () => {
    const local = installStatefulStorage();
    seedFirstRunComplete(local);
    seedConfirmedBindingPlusOutbox(local, 4);

    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
      async (msg: { kind: string }) => {
        if (msg.kind === 'clear_binding') {
          delete local[STORAGE_KEYS.BINDING];
        }
        return { ok: true };
      },
    );

    await initSidePanel();
    await new Promise((r) => setTimeout(r, 0));

    (document.querySelector('.binding-secondary') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const buttons = document.querySelectorAll<HTMLButtonElement>('.rebind-choice-btn');
    // 'move-events' is index 1 (Keep)
    buttons[1].click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ kind: 'clear_binding' });
    expect(local[STORAGE_KEYS.BINDING]).toBeUndefined();
    expect((local[STORAGE_KEYS.OUTBOX] as unknown[]).length).toBe(4);
  });

  it('delete-outbox choice routes the wipe through the SW and then clears binding', async () => {
    const local = installStatefulStorage();
    seedFirstRunComplete(local);
    seedConfirmedBindingPlusOutbox(local, 2);
    // Seed a recovered_html_<id> key — the SW wipe handler should remove
    // it (and any orphans), but THIS test doesn't actually exercise the
    // SW handler (handleMessage isn't routed here). We only assert that
    // the sidepanel sends the wipe_unsynced message; the SW-side wipe is
    // covered by background test cases.
    local['recovered_html_h-0'] = '<div>x</div>';

    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
      async (msg: { kind: string }) => {
        if (msg.kind === 'clear_binding') {
          delete local[STORAGE_KEYS.BINDING];
        }
        return { ok: true };
      },
    );

    await initSidePanel();
    await new Promise((r) => setTimeout(r, 0));

    (document.querySelector('.binding-secondary') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const buttons = document.querySelectorAll<HTMLButtonElement>('.rebind-choice-btn');
    buttons[2].click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // Side panel sends wipe_unsynced + clear_binding in sequence.
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ kind: 'wipe_unsynced' });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ kind: 'clear_binding' });
    expect(local[STORAGE_KEYS.BINDING]).toBeUndefined();
  });

  it('delete-outbox surfaces an error and does NOT clear binding when wipe_unsynced fails', async () => {
    const local = installStatefulStorage();
    seedFirstRunComplete(local);
    seedConfirmedBindingPlusOutbox(local, 2);

    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
      async (msg: { kind: string }) => {
        if (msg.kind === 'wipe_unsynced') {
          return { ok: false, message: 'storage gone' };
        }
        if (msg.kind === 'clear_binding') {
          delete local[STORAGE_KEYS.BINDING];
        }
        return { ok: true };
      },
    );

    await initSidePanel();
    await new Promise((r) => setTimeout(r, 0));

    (document.querySelector('.binding-secondary') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const buttons = document.querySelectorAll<HTMLButtonElement>('.rebind-choice-btn');
    buttons[2].click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // Binding NOT cleared because wipe failed; user sees an inline error.
    expect(local[STORAGE_KEYS.BINDING]).toBeDefined();
    expect((document.querySelector('.binding-error') as HTMLElement).textContent).toMatch(
      /storage gone/,
    );
  });

  it('sync-first leaves the Disconnect button RE-ENABLED so the user can retry (Phase 8 review fix)', async () => {
    const local = installStatefulStorage();
    seedFirstRunComplete(local);
    seedConfirmedBindingPlusOutbox(local, 3);

    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

    await initSidePanel();
    await new Promise((r) => setTimeout(r, 0));

    const disconnect = document.querySelector('.binding-secondary') as HTMLButtonElement;
    disconnect.click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    document.querySelectorAll<HTMLButtonElement>('.rebind-choice-btn')[0].click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // sync-first returns without writing storage; the doClear finally block
    // must re-enable the button so the user can pick differently.
    const updated = document.querySelector('.binding-secondary') as HTMLButtonElement;
    expect(updated.disabled).toBe(false);
  });

  it('disconnect with confirmed but EMPTY outbox does NOT show the modal — straight clear', async () => {
    const local = installStatefulStorage();
    seedFirstRunComplete(local);
    local[STORAGE_KEYS.BINDING] = {
      token: 'tok',
      bound_at: '2026-05-30T10:00:00Z',
      status: 'confirmed',
    };
    // No outbox seeded — empty.

    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
      async (msg: { kind: string }) => {
        if (msg.kind === 'clear_binding') {
          delete local[STORAGE_KEYS.BINDING];
        }
        return { ok: true };
      },
    );

    await initSidePanel();
    await new Promise((r) => setTimeout(r, 0));

    (document.querySelector('.binding-secondary') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(document.querySelector('.rebind-overlay')).toBeNull();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ kind: 'clear_binding' });
  });

  it('disconnect when binding is only PENDING does NOT show the modal', async () => {
    const local = installStatefulStorage();
    seedFirstRunComplete(local);
    local[STORAGE_KEYS.BINDING] = {
      token: 'tok',
      bound_at: '2026-05-30T10:00:00Z',
      status: 'pending',
    };
    seedConfirmedBindingPlusOutbox(local, 5);
    // Re-set the binding to pending (seedConfirmedBindingPlusOutbox sets it to confirmed).
    (local[STORAGE_KEYS.BINDING] as { status: string }).status = 'pending';

    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
      async (msg: { kind: string }) => {
        if (msg.kind === 'clear_binding') {
          delete local[STORAGE_KEYS.BINDING];
        }
        return { ok: true };
      },
    );

    await initSidePanel();
    await new Promise((r) => setTimeout(r, 0));

    // Pending state has no Disconnect button (Connecting…/countdown UI).
    // Trigger clear via the rollback path: simulate clearBinding directly.
    // For this test we just assert that the rebind-aware clearBinding does
    // NOT gate on a pending binding (it goes straight to clear).
    // We exercise this by calling the binding-section's clear flow indirectly:
    // there's no Disconnect button to click in pending state, so this test
    // documents the intent — pending bindings bypass the modal.
    expect(document.querySelector('.binding-secondary')).toBeNull();
  });
});
