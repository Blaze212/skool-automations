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

import type { OutboxEntry, HistoryEntry, EventType, Settings } from '../types.ts';
import {
  DEFAULT_SETTINGS,
  historyStore,
  outboxStore,
  badgeStore,
  settingsStore,
} from '../storage.ts';
import { renderFirstRunModal } from './first-run-modal.ts';
import { renderSettingsSection } from './settings-section.ts';

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
} {
  if (source === 'ai-recovered') return { label: 'AI', className: 'badge badge-ai' };
  return { label: 'selectors', className: 'badge badge-selectors' };
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
  now: number = Date.now(),
): number {
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
    appendBadge(summary, src.label, src.className);
    appendBadge(summary, 'pending', 'badge badge-pending');

    wrap.appendChild(summary);

    const meta = document.createElement('div');
    meta.className = 'meta';

    const eventTypeLine = document.createElement('div');
    eventTypeLine.textContent = prettyEventType(entry.event.event_type);
    meta.appendChild(eventTypeLine);

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

export async function initSidePanel(): Promise<void> {
  const settingsRoot = document.getElementById('settings-section') as HTMLElement;
  const unsyncedList = document.getElementById('unsynced-list') as HTMLElement;
  const unsyncedCount = document.getElementById('unsynced-count') as HTMLElement;
  const activityList = document.getElementById('activity-list') as HTMLElement;
  const modalRoot = document.getElementById('modal-root') as HTMLElement;

  // Parallel storage gather. Settings read is best-effort (default-fallback);
  // a corrupted SETTINGS key must not block the events view from rendering.
  const [settings, outbox, history] = await Promise.all([
    readSettingsOrDefault(),
    outboxStore.get(),
    historyStore.get(),
  ]);

  // Render events + clear the unread badge BEFORE the modal. Two reasons:
  //   (1) Phase 5 invariant — opening the panel always repaints the toolbar
  //       badge. Deferring this behind the modal would mean a user reading the
  //       disclosure sees the badge still painted as unread.
  //   (2) If the modal hangs (commit keeps failing AND user never clicks
  //       Skip), initSidePanel must still resolve with a usable surface —
  //       events visible, badge cleared.
  renderUnsynced(unsyncedList, unsyncedCount, outbox);
  renderActivity(activityList, history);
  await clearUnreadCounter();

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
