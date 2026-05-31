// Spec 012 Phase 5 — publishable build's side panel shell.
//
// Two regions per D6:
//   1. Unsynced events list — top-500 entries from outbox, capture order newest-
//      first. Structured fields only (name, title, profile URL, event_type,
//      source badge, captured ts). Older entries remain in storage; they're
//      just not in the DOM.
//   2. Recent activity strip — HISTORY (cap HISTORY_CAP=10).
//
// Hard rule (D-rev-30): the side panel NEVER reads or renders recovered_html.
// Not at list mount, not on row expand. Recovered HTML is a wire-format payload
// for the backend / CSV export only. This module imports no symbol from
// storage.ts that would let it call recoveredHtmlStore.* — defense in depth.

import type { ExtensionBinding, OutboxEntry, HistoryEntry, EventType, Settings } from '../types.ts';
import { STORAGE_KEYS } from '../types.ts';
import {
  DEFAULT_SETTINGS,
  bindingStore,
  historyStore,
  outboxStore,
  badgeStore,
  settingsStore,
} from '../storage.ts';
import { renderFirstRunModal } from './first-run-modal.ts';
import { renderSettingsSection } from './settings-section.ts';
import { renderBindingSection } from './binding-section.ts';
import { renderRebindModal, type RebindChoice } from './rebind-modal.ts';

const SIDE_PANEL_LIST_LIMIT = 500;

function prettyEventType(t: EventType): string {
  switch (t) {
    case 'connection_request':
      return 'connection request';
    case 'accepted_connection':
      return 'accepted';
    case 'direct_message':
      return 'direct message';
  }
}

function formatRelative(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const deltaMs = Math.max(0, now - then);
  const min = Math.floor(deltaMs / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(then).toLocaleDateString();
}

function sourceBadge(source: 'selectors' | 'ai-recovered' | undefined): {
  label: string;
  className: string;
} | null {
  if (source === 'ai-recovered') return { label: 'AI', className: 'badge badge-ai' };
  return null;
}

function eventTypeBadge(eventType: EventType): { label: string; className: string } {
  switch (eventType) {
    case 'direct_message':
      return { label: 'DM', className: 'badge badge-dm' };
    case 'connection_request':
      return { label: 'Connect', className: 'badge badge-connect' };
    case 'accepted_connection':
      return { label: 'Accepted', className: 'badge badge-accepted' };
  }
}

function statusBadge(status: HistoryEntry['status']): { label: string; className: string } {
  if (status === 'error') return { label: 'error', className: 'badge badge-error' };
  if (status === 'partial') return { label: 'partial', className: 'badge badge-partial' };
  if (status === 'pending') return { label: 'pending', className: 'badge badge-pending' };
  return { label: 'ok', className: 'badge badge-ok' };
}

function setText(el: HTMLElement, text: string): void {
  el.textContent = text;
}

/**
 * Strict allow-list for hrefs we'll render into the panel. The `linkedin_url`
 * field flows from the content-script extraction over the LinkedIn DOM — a
 * compromised page (or a corrupted storage row carried over from a prior
 * version) could feed us `javascript:`, `data:`, or `chrome-extension:`
 * scheme URLs. Anchoring strictly to https://www.linkedin.com keeps both the
 * runtime click safe and the displayed text honest (we still render the raw
 * value as text content even when we refuse to make it clickable).
 */
function isSafeLinkedInUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      (parsed.hostname === 'www.linkedin.com' || parsed.hostname === 'linkedin.com')
    );
  } catch {
    return false;
  }
}

function appendBadge(parent: HTMLElement, label: string, className: string): void {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = label;
  parent.appendChild(span);
}

/**
 * Render the unsynced-events list. Returns the count actually rendered so the
 * "showing N of M" header can stay honest when the outbox exceeds the limit.
 *
 * Spec D-rev-30 — recovered_html is NOT consulted at any point. The row expand
 * (<details>) shows structured event fields only.
 */
export function renderUnsynced(
  list: HTMLElement,
  countEl: HTMLElement,
  outbox: OutboxEntry[],
  opts: { captureMessageBodies?: boolean; now?: number } = {},
): number {
  const now = opts.now ?? Date.now();
  const captureMessageBodies = opts.captureMessageBodies ?? false;

  list.replaceChildren();

  const total = outbox.length;
  if (total === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No unsynced events. Activity from LinkedIn shows up here.';
    list.appendChild(empty);
    countEl.textContent = '';
    return 0;
  }

  // Capture order newest-first. content.ts appends, so reverse a copy.
  const ordered = [...outbox].reverse();
  const visible = ordered.slice(0, SIDE_PANEL_LIST_LIMIT);

  for (const entry of visible) {
    const wrap = document.createElement('details');
    wrap.className = 'row';

    const summary = document.createElement('summary');
    summary.className = 'row-head';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = entry.event.name || '(no name)';

    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = formatRelative(entry.enqueued_at, now);

    summary.append(name, time);

    const src = sourceBadge(entry.event.source);
    if (src) appendBadge(summary, src.label, src.className);
    const evtBadge = eventTypeBadge(entry.event.event_type);
    appendBadge(summary, evtBadge.label, evtBadge.className);

    wrap.appendChild(summary);

    const meta = document.createElement('div');
    meta.className = 'meta';

    if (entry.event.title) {
      const titleLine = document.createElement('div');
      titleLine.textContent = entry.event.title;
      meta.appendChild(titleLine);
    }

    if (entry.event.linkedin_url) {
      const urlLine = document.createElement('div');
      if (isSafeLinkedInUrl(entry.event.linkedin_url)) {
        const a = document.createElement('a');
        a.href = entry.event.linkedin_url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = entry.event.linkedin_url;
        urlLine.appendChild(a);
      } else {
        // Display untrusted URLs as plain text — no click target. Keeps the
        // panel honest about what we captured without giving a malformed or
        // hostile value an active surface.
        urlLine.textContent = entry.event.linkedin_url;
      }
      meta.appendChild(urlLine);
    }

    // Spec 012 Phase 11 — captured timestamp in row expand.
    const tsLine = document.createElement('div');
    tsLine.className = 'meta-timestamp';
    tsLine.textContent = `Captured: ${entry.enqueued_at}`;
    meta.appendChild(tsLine);

    // Spec 012 Phase 11 — message_text shown only when capture_message_bodies
    // is on and the field is non-empty. D-rev-30: recovered_html is never shown.
    if (captureMessageBodies && entry.event.message_text) {
      const msgLine = document.createElement('div');
      msgLine.className = 'meta-message';
      msgLine.textContent = entry.event.message_text;
      meta.appendChild(msgLine);
    }

    const sync = document.createElement('div');
    sync.className = 'sync-status';
    sync.textContent = 'Captured locally — needs sync';
    meta.appendChild(sync);

    wrap.appendChild(meta);
    list.appendChild(wrap);
  }

  if (total > visible.length) {
    const note = document.createElement('div');
    note.className = 'truncation-note';
    note.textContent = `Showing ${visible.length} of ${total} unsynced events. Sync to clear.`;
    list.appendChild(note);
  }

  countEl.textContent = total === visible.length ? `${total}` : `${visible.length} of ${total}`;
  return visible.length;
}

export function renderActivity(
  list: HTMLElement,
  history: HistoryEntry[],
  now: number = Date.now(),
): void {
  list.replaceChildren();

  if (history.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No recent activity.';
    list.appendChild(empty);
    return;
  }

  for (const entry of history) {
    const row = document.createElement('div');
    row.className = 'row';

    const head = document.createElement('div');
    head.className = 'row-head';

    const name = document.createElement('span');
    name.className = 'name';
    setText(name, entry.name || '(unknown)');

    const time = document.createElement('span');
    time.className = 'time';
    setText(time, formatRelative(entry.ts, now));

    const status = statusBadge(entry.status);

    head.append(name, time);
    appendBadge(head, status.label, status.className);
    row.appendChild(head);

    if (entry.message) {
      const meta = document.createElement('div');
      meta.className = 'meta';
      setText(meta, entry.message);
      row.appendChild(meta);
    }

    list.appendChild(row);
  }
}

/**
 * Mark the unread-counter as acknowledged on side-panel open. Mirrors the
 * popup's clearUnreadCounter — without it the badge would stay red/amber even
 * after the user has clearly seen the events in the panel.
 *
 * Unlike the popup, the publishable badge composes `highestSeverity` with the
 * unsynced count at paint time. Clearing the severity in storage alone leaves
 * the toolbar painted with the prior ✕/! until the next `drain_outbox` arrives
 * — so we explicitly nudge the SW with a `drain_outbox` message, which routes
 * to `refreshPublishableBadge` in the publishable build. Failure is non-fatal
 * (worst case: stale badge until next capture).
 */
async function clearUnreadCounter(): Promise<void> {
  await badgeStore.setPartial({ unreadCount: 0, highestSeverity: 'ok' });
  try {
    await chrome.runtime.sendMessage({ kind: 'drain_outbox' });
  } catch (err) {
    console.warn('[Pipeline Tracker side panel] badge refresh nudge failed:', err);
  }
}

/**
 * Mount the settings section + bind the capture-bodies toggle to the
 * settingsStore. Re-rendered after the first-run modal closes so the section
 * reflects the freshly-committed `capture_message_bodies` value.
 */
function mountSettings(root: HTMLElement, settings: Settings): void {
  renderSettingsSection(root, {
    settings,
    update: (patch) => settingsStore.update(patch),
  });
}

/**
 * Mount the first-run modal if `first_run_completed === false` and resolve
 * with the post-commit settings. The modal can either commit (resolves with
 * the freshly-persisted snapshot) or skip-without-saving (resolves with the
 * input snapshot, first_run_completed unchanged — modal returns next open).
 *
 * Already-completed first-run is a no-op; the original snapshot returns.
 *
 * Caller (`initSidePanel`) treats this as best-effort: if it throws or never
 * resolves, the rest of the panel has already rendered, so the user is not
 * blocked from seeing their events.
 */
async function maybeShowFirstRunModal(root: HTMLElement, settings: Settings): Promise<Settings> {
  if (settings.first_run_completed) return settings;
  let committed: Settings = settings;
  await renderFirstRunModal(root, {
    settings,
    commit: async (patch) => {
      committed = await settingsStore.update(patch);
    },
  });
  return committed;
}

/**
 * Best-effort settings read with a default-fallback. A corrupted or
 * unreadable SETTINGS key must not brick the events surface — the unsynced
 * list and recent-activity strip are the load-bearing user value, and they
 * are independent of any settings field.
 */
async function readSettingsOrDefault(): Promise<Settings> {
  try {
    return await settingsStore.get();
  } catch (err) {
    console.warn('[Pipeline Tracker side panel] settings read failed; using defaults:', err);
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Mount the binding section + subscribe to chrome.storage.onChanged so the
 * SW's bind-ack handler (which writes status='confirmed' to bindingStore)
 * drives a live re-render. Returns an unsubscribe; the caller usually never
 * invokes it (the panel is GC'd when Chrome closes it) but tests use it to
 * tear down between cases.
 *
 * The handle returned by renderBindingSection is STABLE — it mutates the
 * body in place via setBinding(next). The storage listener used to call
 * renderBindingSection(root, ...) again (rebuilding the section subtree),
 * which detached the body element click handlers were closing over and
 * silently swallowed error messages from delivered=0 / sendMessage failure
 * paths. Code review for Phase 7 caught this across three angles — fix is
 * to keep one handle for the life of the mount and update via setBinding.
 *
 * D-rev-12 SW lifecycle: the SW cannot push to the side panel directly
 * (runtime message channel only opens for messages FROM the side panel TO
 * the SW). Storage change events are the canonical cross-context signal
 * Chrome guarantees here.
 */
interface MountBindingOpts {
  /** Override the Disconnect path so sidepanel.ts can interpose the rebind 3-choice modal. */
  clearBinding?: () => Promise<void>;
  /** Phase 8 D-rev-9 — opens app.cmcareersystems.com in a new tab. */
  openAppTab?: () => void;
}

function mountBinding(
  root: HTMLElement,
  binding: ExtensionBinding | null,
  overrides: MountBindingOpts = {},
): () => void {
  const handle = renderBindingSection(root, {
    binding,
    startBinding: async () => {
      const resp = await chrome.runtime.sendMessage({ kind: 'start_binding' });
      return (resp ?? { ok: false }) as {
        ok: boolean;
        message?: string;
        delivered?: number;
      };
    },
    clearBinding:
      overrides.clearBinding ??
      (async () => {
        await chrome.runtime.sendMessage({ kind: 'clear_binding' });
      }),
    openAppTab: overrides.openAppTab,
  });

  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== 'local') return;
    if (!(STORAGE_KEYS.BINDING in changes)) return;
    void bindingStore.get().then((next) => handle.setBinding(next));
  };

  // chrome.storage.onChanged is the Chrome-guaranteed cross-context signal
  // between SW and side panel. It's not banned by guard #2 (which targets
  // chrome.storage.local.{get,set,remove,clear} specifically); subscriptions
  // are read-only and safe to use here.
  chrome.storage.onChanged.addListener(listener);

  return () => {
    chrome.storage.onChanged.removeListener(listener);
    handle.destroy();
  };
}

/**
 * Module-scoped unsubscribe handle — guarantees that re-entrant initSidePanel
 * calls (e.g. DOMContentLoaded firing twice during dev reload, or a future
 * re-init path) don't leak chrome.storage.onChanged listeners. Each new
 * mount tears down the prior subscription before installing its own.
 */
let _bindingUnsubscribe: (() => void) | null = null;

/**
 * Phase 8 D-rev-19 — wraps the Disconnect path in a rebind 3-choice modal
 * when the prior binding is `confirmed` AND the outbox still holds unsynced
 * events. Without this, a different CareerSystems user logging in on the
 * same Chrome profile could silently inherit the prior user's outbox. The
 * three choices are mutually exclusive; the modal has no default.
 *
 * - 'sync-first'     → cancel disconnect, do not clear anything. The user
 *                       opens the app, syncs, then disconnects cleanly.
 * - 'move-events'    → clear binding only; outbox preserved. Re-binding
 *                       to a different account routes those events there.
 * - 'delete-outbox'  → clear outbox (and per-id recovered_html) THEN clear
 *                       binding. Fresh start.
 */
async function rebindAwareClearBinding(modalRoot: HTMLElement): Promise<void> {
  const cur = await bindingStore.get();
  if (cur?.status === 'confirmed') {
    const outbox = await outboxStore.get();
    if (outbox.length > 0) {
      const choice: RebindChoice = await renderRebindModal(modalRoot, {
        unsyncedCount: outbox.length,
      });
      if (choice === 'sync-first') {
        // Cancel disconnect. Leave binding + outbox intact.
        return;
      }
      if (choice === 'delete-outbox') {
        // Route through the SW (Phase 8 review fix). The SW takes a fresh
        // snapshot inside its handler — events captured during the modal
        // are wiped consistently — enumerates ALL recovered_html_* keys
        // (orphan cleanup), and filters matching pending HistoryEntry
        // rows so the Recent activity strip doesn't end up with sticky
        // pending entries forever. Doing this in the SW also preserves
        // sidepanel.ts's D-rev-30 invariant: this module imports no
        // symbol that would let it touch recovered_html.
        const result = (await chrome.runtime.sendMessage({ kind: 'wipe_unsynced' })) as
          | {
              ok?: boolean;
              message?: string;
            }
          | undefined;
        if (!result?.ok) {
          throw new Error(result?.message ?? 'wipe_unsynced failed');
        }
      }
      // 'move-events' falls through — keep outbox, just clear binding.
    }
  }
  await chrome.runtime.sendMessage({ kind: 'clear_binding' });
}

function defaultOpenAppTab(): void {
  // chrome.tabs.create in MV3 returns a Promise; the synchronous try/catch
  // would miss async rejections (no `tabs` permission required for the call
  // itself, but policy / popup-blocker can still reject). Use .catch so
  // failures land in the warn log instead of becoming unhandled rejections.
  try {
    const ret = chrome.tabs.create({ url: 'https://app.cmcareersystems.com/' });
    if (ret && typeof (ret as Promise<unknown>).catch === 'function') {
      void (ret as Promise<unknown>).catch((err: unknown) => {
        console.warn('[Pipeline Tracker side panel] chrome.tabs.create rejected:', err);
      });
    }
  } catch (err) {
    console.warn('[Pipeline Tracker side panel] chrome.tabs.create threw:', err);
  }
}

/**
 * Best-effort wrapper around mountBinding so an exception in the binding
 * subtree (e.g. bindingRoot is null after a template edit) cannot poison
 * the Phase 6 invariant: events render + first-run modal still gets a
 * chance to mount. We swallow + log; the user sees no binding section but
 * the rest of the panel is intact.
 *
 * Phase 8 — passes the rebind-aware clearBinding and the chrome.tabs.create
 * openAppTab into the binding section.
 */
function safelyMountBinding(
  root: HTMLElement,
  binding: ExtensionBinding | null,
  modalRoot: HTMLElement,
): void {
  try {
    if (_bindingUnsubscribe) {
      _bindingUnsubscribe();
      _bindingUnsubscribe = null;
    }
    _bindingUnsubscribe = mountBinding(root, binding, {
      clearBinding: () => rebindAwareClearBinding(modalRoot),
      openAppTab: defaultOpenAppTab,
    });
  } catch (err) {
    console.error('[Pipeline Tracker side panel] mountBinding failed:', err);
  }
}

/** Test-only — tear down the binding subscription between cases. */
export function _resetBindingMountForTests(): void {
  if (_bindingUnsubscribe) {
    _bindingUnsubscribe();
    _bindingUnsubscribe = null;
  }
  if (_unsyncedListUnsubscribe) {
    _unsyncedListUnsubscribe();
    _unsyncedListUnsubscribe = null;
  }
}

/**
 * Phase 8 — keep the unsynced events list + count badge in sync with
 * chrome.storage when OUTBOX changes. The SW's wipe_unsynced handler
 * writes to OUTBOX, and the user expects the panel's events list to
 * reflect that immediately (Phase 8 review angle C/4 finding). Mirrors
 * the binding section's storage.onChanged wiring.
 */
let _unsyncedListUnsubscribe: (() => void) | null = null;

function mountUnsyncedListListener(
  list: HTMLElement,
  countEl: HTMLElement,
  captureMessageBodies: boolean,
): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== 'local') return;
    if (!(STORAGE_KEYS.OUTBOX in changes)) return;
    void outboxStore
      .get()
      .then((next) => renderUnsynced(list, countEl, next, { captureMessageBodies }));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

function safelyMountUnsyncedListener(
  list: HTMLElement,
  countEl: HTMLElement,
  captureMessageBodies: boolean,
): void {
  if (_unsyncedListUnsubscribe) {
    _unsyncedListUnsubscribe();
    _unsyncedListUnsubscribe = null;
  }
  try {
    _unsyncedListUnsubscribe = mountUnsyncedListListener(list, countEl, captureMessageBodies);
  } catch (err) {
    console.error('[Pipeline Tracker side panel] mountUnsyncedListListener failed:', err);
  }
}

export async function initSidePanel(): Promise<void> {
  const settingsRoot = document.getElementById('settings-section') as HTMLElement;
  const bindingRoot = document.getElementById('binding-section') as HTMLElement;
  const unsyncedList = document.getElementById('unsynced-list') as HTMLElement;
  const unsyncedCount = document.getElementById('unsynced-count') as HTMLElement;
  const activityList = document.getElementById('activity-list') as HTMLElement;
  const modalRoot = document.getElementById('modal-root') as HTMLElement;
  const exportCsvBtn = document.getElementById('export-csv-btn') as HTMLButtonElement | null;

  // Parallel storage gather. Settings read is best-effort (default-fallback);
  // a corrupted SETTINGS key must not block the events view from rendering.
  const [settings, outbox, history, binding] = await Promise.all([
    readSettingsOrDefault(),
    outboxStore.get(),
    historyStore.get(),
    bindingStore.get(),
  ]);

  const captureMessageBodies = settings.capture_message_bodies;

  // Render events + clear the unread badge BEFORE the modal. Two reasons:
  //   (1) Phase 5 invariant — opening the panel always repaints the toolbar
  //       badge. Deferring this behind the modal would mean a user reading the
  //       disclosure sees the badge still painted as unread.
  //   (2) If the modal hangs (commit keeps failing AND user never clicks
  //       Skip), initSidePanel must still resolve with a usable surface —
  //       events visible, badge cleared.
  renderUnsynced(unsyncedList, unsyncedCount, outbox, { captureMessageBodies });
  renderActivity(activityList, history);
  await clearUnreadCounter();

  // Phase 11 — Export CSV button. Delegates to the SW (background handles
  // the chrome.downloads.download call so sidepanel.ts never touches
  // recoveredHtmlStore — D-rev-30 invariant maintained).
  if (exportCsvBtn) {
    exportCsvBtn.addEventListener('click', () => {
      exportCsvBtn.disabled = true;
      chrome.runtime
        .sendMessage({ kind: 'export_csv' })
        .catch((err: Error) =>
          console.warn('[Pipeline Tracker side panel] export_csv failed:', err),
        )
        .finally(() => {
          exportCsvBtn.disabled = false;
        });
    });
  }

  // Phase 8 — keep the unsynced events list in sync when the SW wipes the
  // outbox (delete-outbox rebind choice) or any other code mutates OUTBOX.
  // Without this listener the panel shows stale rows until next open.
  safelyMountUnsyncedListener(unsyncedList, unsyncedCount, captureMessageBodies);

  // Binding section mounts independently of the first-run modal: a user
  // can read the disclosure with the section visible behind it (the
  // overlay catches clicks so they cannot interact until the modal is
  // closed). Subscribing to storage.onChanged here means bind-ack flips
  // from the SW reach the panel without any polling. Wrapped in a
  // best-effort to preserve Phase 6's "modal/events must still render
  // even if a subtree fails" invariant. modalRoot is passed in for the
  // Phase 8 rebind 3-choice modal (D-rev-19).
  safelyMountBinding(bindingRoot, binding, modalRoot);

  // Mount the modal asynchronously. We deliberately do NOT await it inside
  // initSidePanel — see (2) above. The settings section is mounted only
  // AFTER the modal commits (or is skipped), so the user can't toggle
  // capture_message_bodies via the settings UI before they've seen the
  // disclosure. A modal mount error logs + drops the settings section for
  // this open; the user will see the modal again next session.
  void maybeShowFirstRunModal(modalRoot, settings)
    .then((finalSettings) => mountSettings(settingsRoot, finalSettings))
    .catch((err) => {
      console.warn('[Pipeline Tracker side panel] first-run flow failed:', err);
    });
}

/**
 * Render a visible error state into the panel body when initSidePanel rejects.
 * Without this the catch-and-log path leaves the panel as the empty static
 * shell, indistinguishable from "no events yet" to a user.
 */
function renderInitFailure(err: unknown): void {
  console.error('[Pipeline Tracker side panel] init failed:', err);
  const list = document.getElementById('unsynced-list');
  if (!list) return;
  list.replaceChildren();
  const msg = document.createElement('div');
  msg.className = 'empty';
  msg.textContent = `Side panel failed to load: ${err instanceof Error ? err.message : String(err)}`;
  list.appendChild(msg);
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    initSidePanel().catch(renderInitFailure);
  });
}
