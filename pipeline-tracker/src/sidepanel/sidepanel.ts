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
  enqueueManualCapture,
  historyStore,
  outboxStore,
  badgeStore,
  settingsStore,
  type ManualCaptureInput,
} from '../storage.ts';
import {
  renderCaptureSection,
  type AiExtractionResult,
  type AiTimeout,
  type AiTooLarge,
  type CaptureSectionHandle,
} from './capture-section.ts';
import {
  extractContact,
  getCachedAvailability,
  stripHtmlForCarry,
  stripHtmlForCarryWithStatus,
  type ContactFields,
} from '@cs/scraping-core';
import { capFragment } from '../capture-heuristic.ts';
import { renderFirstRunModal } from './first-run-modal.ts';
import { renderSettingsSection } from './settings-section.ts';
import { renderBindingSection } from './binding-section.ts';
import { renderRebindModal, type RebindChoice } from './rebind-modal.ts';
import { renderReviewSection, type ReviewEntryEdits } from './review-section.ts';
import { type EditableEventFields, buildEditableFields } from './editable-fields.ts';

const SIDE_PANEL_LIST_LIMIT = 500;

function prettyEventType(t: EventType): string {
  switch (t) {
    case 'connection_request':
      return 'connection request';
    case 'accepted_connection':
      return 'accepted';
    case 'direct_message':
      return 'direct message';
    case 'offered_value_add':
      return 'offered value add';
    case 'sent_value_add':
      return 'sent value add';
    case 'scheduled_call':
      return 'scheduled call';
    case 'follow_up':
      return 'follow up';
    case 'no_action':
      return 'no action';
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
    case 'offered_value_add':
      return { label: 'Offered VA', className: 'badge badge-offered-va' };
    case 'sent_value_add':
      return { label: 'Sent VA', className: 'badge badge-sent-va' };
    case 'scheduled_call':
      return { label: 'Call', className: 'badge badge-call' };
    case 'follow_up':
      return { label: 'Follow Up', className: 'badge badge-follow-up' };
    case 'no_action':
      return { label: 'No Action', className: 'badge badge-no-action' };
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
 * Spec 016 review S-2 — allow ANY https URL to render as a clickable link. The XSS-safe
 * protocol check stays: the dropped/pasted `profile_url` can be arbitrary
 * content, so `javascript:`, `data:`, and `chrome-extension:` scheme URLs are
 * still refused a click target (we render the raw value as text content instead).
 */
function isSafeProfileUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
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
/**
 * Spec 015 B2 (extended) — render the unsynced-events list.
 *
 * Every row is editable when `onEdit` is supplied: expanding a row reveals the
 * captured name / title / profile URL / message as inputs with a Save button,
 * routed (by the caller) through the same `review_outbox_entry` SW path the
 * needs-review queue uses. Without `onEdit` the rows render read-only.
 *
 * Held-back review items (`needs_review && !user_reviewed`) are excluded here —
 * they live in the needs-review queue above so each pending capture is editable
 * in exactly one place. Once reviewed/approved they reappear in this list.
 */
export function renderUnsynced(
  list: HTMLElement,
  countEl: HTMLElement,
  outbox: OutboxEntry[],
  opts: {
    captureMessageBodies?: boolean;
    now?: number;
    onEdit?: (historyId: string, edits: EditableEventFields) => void | Promise<void>;
    onDelete?: (historyId: string) => void | Promise<void>;
  } = {},
): number {
  const now = opts.now ?? Date.now();
  const captureMessageBodies = opts.captureMessageBodies ?? false;
  const onEdit = opts.onEdit;
  const onDelete = opts.onDelete;

  list.replaceChildren();

  // Exclude captures still awaiting review — they're shown (and edited) in the
  // needs-review queue, not here. Reviewed/approved rows fall through to this list.
  const pending = outbox.filter((e) => !(e.needs_review && !e.user_reviewed));

  const total = pending.length;
  if (total === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No unsynced events. Drag or paste a contact above to capture one.';
    list.appendChild(empty);
    countEl.textContent = '';
    return 0;
  }

  // Capture order newest-first. content.ts appends, so reverse a copy.
  const ordered = [...pending].reverse();
  const visible = ordered.slice(0, SIDE_PANEL_LIST_LIMIT);

  for (const entry of visible) {
    const wrap = document.createElement('details');
    wrap.className = 'row';
    wrap.dataset.historyId = entry.history_id;

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

    if (onEdit) {
      renderEditableRowBody(meta, entry, onEdit, onDelete);
    } else {
      renderReadonlyRowBody(meta, entry, captureMessageBodies);
    }

    // Spec 012 Phase 11 — captured timestamp in row expand.
    const tsLine = document.createElement('div');
    tsLine.className = 'meta-timestamp';
    tsLine.textContent = `Captured: ${entry.enqueued_at}`;
    meta.appendChild(tsLine);

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

/** Read-only row body (no `onEdit`): structured fields as static text. */
function renderReadonlyRowBody(
  meta: HTMLElement,
  entry: OutboxEntry,
  captureMessageBodies: boolean,
): void {
  if (entry.event.title) {
    const titleLine = document.createElement('div');
    titleLine.textContent = entry.event.title;
    meta.appendChild(titleLine);
  }

  if (entry.event.profile_url) {
    const urlLine = document.createElement('div');
    if (isSafeProfileUrl(entry.event.profile_url)) {
      const a = document.createElement('a');
      a.href = entry.event.profile_url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = entry.event.profile_url;
      urlLine.appendChild(a);
    } else {
      // Display untrusted URLs as plain text — no click target. Keeps the
      // panel honest about what we captured without giving a malformed or
      // hostile value an active surface.
      urlLine.textContent = entry.event.profile_url;
    }
    meta.appendChild(urlLine);
  }

  // Spec 012 Phase 11 — message_text shown only when capture_message_bodies
  // is on and the field is non-empty. D-rev-30: recovered_html is never shown.
  if (captureMessageBodies && entry.event.message_text) {
    const msgLine = document.createElement('div');
    msgLine.className = 'meta-message';
    msgLine.textContent = entry.event.message_text;
    meta.appendChild(msgLine);
  }
}

/**
 * Editable row body — name / title / profile URL / message inputs + a Save
 * button. Save snapshots the trimmed values and hands them to `onEdit`, which
 * the caller routes through `review_outbox_entry` (persists the edit, marks the
 * row user_reviewed, drops any recovered_html). The button disables while in
 * flight and re-enables on failure so the user can retry.
 */
function renderEditableRowBody(
  meta: HTMLElement,
  entry: OutboxEntry,
  onEdit: (historyId: string, edits: EditableEventFields) => void | Promise<void>,
  onDelete?: (historyId: string) => void | Promise<void>,
): void {
  const { rows, getEdits } = buildEditableFields({
    name: entry.event.name ?? '',
    title: entry.event.title ?? '',
    // Internal field name ← wire-contract PipelineEvent.profile_url.
    profile_url: entry.event.profile_url ?? '',
    message_text: entry.event.message_text ?? '',
  });
  meta.append(...rows);

  const actions = document.createElement('div');
  actions.className = 'review-actions';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'review-save-btn';
  saveBtn.textContent = 'Save';
  let savedTimer: ReturnType<typeof setTimeout> | null = null;
  saveBtn.addEventListener('click', () => {
    if (savedTimer) {
      clearTimeout(savedTimer);
      savedTimer = null;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    void Promise.resolve(onEdit(entry.history_id, getEdits()))
      .then(() => {
        // Re-enable so the user can edit + save again (a successful save used to
        // leave the button stuck disabled). Show a brief "Saved ✓" confirmation.
        saveBtn.disabled = false;
        saveBtn.textContent = 'Saved ✓';
        savedTimer = setTimeout(() => {
          saveBtn.textContent = 'Save';
          savedTimer = null;
        }, 1500);
      })
      .catch((err: unknown) => {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
        console.warn('[Pipeline Tracker side panel] edit save failed:', err);
      });
  });

  actions.appendChild(saveBtn);

  // Delete — removes the unsynced capture (and its recovered_html) via the SW.
  if (onDelete) {
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'review-delete-btn';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => {
      const confirmFn =
        typeof window !== 'undefined' && typeof window.confirm === 'function'
          ? window.confirm.bind(window)
          : () => true;
      if (!confirmFn('Delete this captured event? This cannot be undone.')) return;
      deleteBtn.disabled = true;
      saveBtn.disabled = true;
      // On success the OUTBOX storage change re-renders the list (the row goes
      // away). On failure, re-enable so the user can retry.
      void Promise.resolve(onDelete(entry.history_id)).catch((err: unknown) => {
        deleteBtn.disabled = false;
        saveBtn.disabled = false;
        console.warn('[Pipeline Tracker side panel] delete failed:', err);
      });
    });
    actions.appendChild(deleteBtn);
  }

  meta.appendChild(actions);
}

/**
 * onEdit for the unsynced list — persist a user's correction to a pending row
 * through the SW (same `review_outbox_entry` path the needs-review queue uses).
 * Throws on a non-ok response so the row's Save button re-enables for a retry.
 */
function editUnsyncedEntry(historyId: string, edits: EditableEventFields): Promise<void> {
  return sendReviewMessage({ kind: 'review_outbox_entry', historyId, edits });
}

/**
 * onDelete for the unsynced list — removes a single capture (and its
 * recovered_html) through the SW. Routed through the SW so the side panel never
 * touches recovered_html (D-rev-30); the OUTBOX storage change re-renders the
 * list so the row disappears. Throws on a non-ok response so the row's buttons
 * re-enable for a retry.
 */
async function deleteUnsyncedEntry(historyId: string): Promise<void> {
  const resp = (await chrome.runtime.sendMessage({ kind: 'delete_outbox_entry', historyId })) as
    | { ok?: boolean; message?: string }
    | undefined;
  if (!resp?.ok) throw new Error(resp?.message ?? 'delete failed');
}

export function renderActivity(
  list: HTMLElement,
  history: HistoryEntry[],
  opts: { captureMessageBodies?: boolean; now?: number } = {},
): void {
  const now = opts.now ?? Date.now();
  const captureMessageBodies = opts.captureMessageBodies ?? false;
  list.replaceChildren();

  if (history.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No recent activity.';
    list.appendChild(empty);
    return;
  }

  for (const entry of history) {
    const wrap = document.createElement('details');
    wrap.className = 'row';

    const summary = document.createElement('summary');
    summary.className = 'row-head';

    const name = document.createElement('span');
    name.className = 'name';
    setText(name, entry.name || '(unknown)');

    const time = document.createElement('span');
    time.className = 'time';
    setText(time, formatRelative(entry.ts, now));

    summary.append(name, time);
    const evtBadge = eventTypeBadge(entry.event_type);
    appendBadge(summary, evtBadge.label, evtBadge.className);
    const status = statusBadge(entry.status);
    appendBadge(summary, status.label, status.className);

    wrap.appendChild(summary);

    const meta = document.createElement('div');
    meta.className = 'meta';

    if (entry.title) {
      const titleLine = document.createElement('div');
      titleLine.textContent = entry.title;
      meta.appendChild(titleLine);
    }

    if (entry.page_url) {
      const urlLine = document.createElement('div');
      urlLine.className = 'meta-url';
      if (isSafeProfileUrl(entry.page_url)) {
        const a = document.createElement('a');
        a.href = entry.page_url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        // Display the path only — short enough to fit on one line.
        try {
          a.textContent =
            new URL(entry.page_url).hostname.replace('www.', '') +
            new URL(entry.page_url).pathname.replace(/\/$/, '');
        } catch {
          a.textContent = entry.page_url;
        }
        urlLine.appendChild(a);
      } else {
        urlLine.textContent = entry.page_url;
      }
      meta.appendChild(urlLine);
    }

    if (captureMessageBodies && entry.message_text) {
      const msgTextLine = document.createElement('div');
      msgTextLine.className = 'meta-message';
      setText(msgTextLine, entry.message_text);
      meta.appendChild(msgTextLine);
    }

    const tsLine = document.createElement('div');
    tsLine.className = 'meta-timestamp';
    tsLine.textContent = `Resolved: ${entry.ts}`;
    meta.appendChild(tsLine);

    if (entry.message) {
      const msgLine = document.createElement('div');
      msgLine.className = 'sync-status';
      setText(msgLine, entry.message);
      meta.appendChild(msgLine);
    }

    wrap.appendChild(meta);
    list.appendChild(wrap);
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
function mountSettings(
  root: HTMLElement,
  settings: Settings,
  binding: ExtensionBinding | null,
  modalRoot: HTMLElement,
): void {
  renderSettingsSection(root, {
    settings,
    update: async (patch) => {
      const next = await settingsStore.update(patch);
      // Keep the cached debug flag (read synchronously by debugLogCaptureFragment)
      // in step with the toggle the moment it persists.
      _debugLogging = next.debug_logging ?? false;
      return next;
    },
    // spec 016 UI — the full CareerSystems sync controls live inside the
    // Settings dropdown; only a compact "Connected as …" line stays on the
    // main panel (mountConnectedIndicator).
    renderBindingInto: (slot) => safelyMountBinding(slot, binding, modalRoot),
  });
}

/**
 * spec 016 UI — compact "Connected as <email>" line on the main panel. The full
 * connect/disconnect controls moved into the Settings dropdown; this is just a
 * read-only status indicator, kept live via chrome.storage.onChanged.
 */
function renderConnectedIndicator(root: HTMLElement, binding: ExtensionBinding | null): void {
  root.replaceChildren();
  if (binding?.status !== 'confirmed') return; // only show when connected
  const el = document.createElement('div');
  el.className = 'connected-indicator';
  el.textContent = binding.account_email
    ? `Connected as ${binding.account_email}`
    : 'Connected to CareerSystems';
  root.appendChild(el);
}

let _connectedIndicatorUnsubscribe: (() => void) | null = null;

function mountConnectedIndicator(root: HTMLElement, binding: ExtensionBinding | null): void {
  if (_connectedIndicatorUnsubscribe) {
    _connectedIndicatorUnsubscribe();
    _connectedIndicatorUnsubscribe = null;
  }
  renderConnectedIndicator(root, binding);
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area !== 'local' || !(STORAGE_KEYS.BINDING in changes)) return;
    void bindingStore.get().then((next) => renderConnectedIndicator(root, next));
  };
  chrome.storage.onChanged.addListener(listener);
  _connectedIndicatorUnsubscribe = () => chrome.storage.onChanged.removeListener(listener);
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
    appBaseUrl: APP_BASE_URL,
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

/**
 * Base URL of the CareerSystems app. Production by default; for local dev point
 * this at http://localhost:5173. Used for the "Visit the app" deep link and the
 * open-app-tab CTA. (Single source of truth — there is no runtime env signal in
 * a published build, so this is the one knob to flip for a dev build.)
 */
const APP_BASE_URL = 'https://app.cmcareersystems.com';
/** The tracker page the user syncs from. */
const APP_TRACKER_URL = `${APP_BASE_URL}/tracker-fractional`;

function defaultOpenAppTab(): void {
  // chrome.tabs.create in MV3 returns a Promise; the synchronous try/catch
  // would miss async rejections (no `tabs` permission required for the call
  // itself, but policy / popup-blocker can still reject). Use .catch so
  // failures land in the warn log instead of becoming unhandled rejections.
  try {
    const ret = chrome.tabs.create({ url: APP_TRACKER_URL });
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
  if (_connectedIndicatorUnsubscribe) {
    _connectedIndicatorUnsubscribe();
    _connectedIndicatorUnsubscribe = null;
  }
  if (_unsyncedListUnsubscribe) {
    _unsyncedListUnsubscribe();
    _unsyncedListUnsubscribe = null;
  }
  if (_activityListUnsubscribe) {
    _activityListUnsubscribe();
    _activityListUnsubscribe = null;
  }
  if (_reviewListUnsubscribe) {
    _reviewListUnsubscribe();
    _reviewListUnsubscribe = null;
  }
  if (_captureHandle) {
    _captureHandle.destroy();
    _captureHandle = null;
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
let _activityListUnsubscribe: (() => void) | null = null;

/**
 * Show the "Sync" button only when there is something to sync. The button
 * opens the tracker tab, which drains the outbox in realtime while open — so
 * with an empty outbox it would be a no-op and is hidden to avoid noise.
 */
function toggleSyncButton(syncBtn: HTMLElement | null, unsyncedCount: number): void {
  if (syncBtn) syncBtn.hidden = unsyncedCount === 0;
}

function mountUnsyncedListListener(
  list: HTMLElement,
  countEl: HTMLElement,
  captureMessageBodies: boolean,
  syncBtn: HTMLElement | null,
): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== 'local') return;
    if (!(STORAGE_KEYS.OUTBOX in changes)) return;
    void outboxStore.get().then((next) => {
      const rendered = renderUnsynced(list, countEl, next, {
        captureMessageBodies,
        onEdit: editUnsyncedEntry,
        onDelete: deleteUnsyncedEntry,
      });
      toggleSyncButton(syncBtn, rendered);
    });
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

function mountActivityListener(list: HTMLElement, captureMessageBodies: boolean): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== 'local') return;
    if (!(STORAGE_KEYS.HISTORY in changes)) return;
    void historyStore.get().then((next) => renderActivity(list, next, { captureMessageBodies }));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

function safelyMountUnsyncedListener(
  list: HTMLElement,
  countEl: HTMLElement,
  captureMessageBodies: boolean,
  syncBtn: HTMLElement | null,
): void {
  if (_unsyncedListUnsubscribe) {
    _unsyncedListUnsubscribe();
    _unsyncedListUnsubscribe = null;
  }
  try {
    _unsyncedListUnsubscribe = mountUnsyncedListListener(
      list,
      countEl,
      captureMessageBodies,
      syncBtn,
    );
  } catch (err) {
    console.error('[Pipeline Tracker side panel] mountUnsyncedListListener failed:', err);
  }
}

function safelyMountActivityListener(list: HTMLElement, captureMessageBodies: boolean): void {
  if (_activityListUnsubscribe) {
    _activityListUnsubscribe();
    _activityListUnsubscribe = null;
  }
  try {
    _activityListUnsubscribe = mountActivityListener(list, captureMessageBodies);
  } catch (err) {
    console.error('[Pipeline Tracker side panel] mountActivityListener failed:', err);
  }
}

// --- Spec 015 B2 — side-panel review queue ---

/** Outbox entries the user still has to review (low-confidence, not yet approved). */
function reviewEntriesOf(outbox: OutboxEntry[]): OutboxEntry[] {
  return outbox.filter((e) => e.needs_review && !e.user_reviewed);
}

/** Route a review action through the SW; throw on a non-ok response so the
 * review-section's per-button .catch re-enables the control. */
async function sendReviewMessage(msg: {
  kind: 'review_outbox_entry' | 'mark_outbox_reviewed';
  historyId?: string;
  historyIds?: string[];
  edits?: ReviewEntryEdits;
}): Promise<void> {
  const resp = (await chrome.runtime.sendMessage(msg)) as
    | { ok?: boolean; message?: string }
    | undefined;
  if (!resp?.ok) throw new Error(resp?.message ?? 'review action failed');
}

/** Render the review queue from an outbox snapshot, wiring actions to the SW. */
export function renderReview(reviewRoot: HTMLElement, outbox: OutboxEntry[]): void {
  renderReviewSection(reviewRoot, {
    entries: reviewEntriesOf(outbox),
    onSave: (historyId, edits) =>
      sendReviewMessage({ kind: 'review_outbox_entry', historyId, edits }),
    onSyncOne: (historyId) =>
      sendReviewMessage({ kind: 'mark_outbox_reviewed', historyIds: [historyId] }),
    onSyncAll: (historyIds) => sendReviewMessage({ kind: 'mark_outbox_reviewed', historyIds }),
  });
}

let _reviewListUnsubscribe: (() => void) | null = null;

function mountReviewListener(reviewRoot: HTMLElement): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== 'local') return;
    if (!(STORAGE_KEYS.OUTBOX in changes)) return;
    void outboxStore.get().then((next) => renderReview(reviewRoot, next));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

function safelyMountReviewListener(reviewRoot: HTMLElement): void {
  if (_reviewListUnsubscribe) {
    _reviewListUnsubscribe();
    _reviewListUnsubscribe = null;
  }
  try {
    _reviewListUnsubscribe = mountReviewListener(reviewRoot);
  } catch (err) {
    console.error('[Pipeline Tracker side panel] mountReviewListener failed:', err);
  }
}

// --- Spec 016 — manual capture card ---

/**
 * Best-effort active-tab URL via `activeTab` (auto-granted when the panel is
 * opened from the toolbar icon) — NOT the broad `tabs` permission (review S-6).
 * Drops to '' when unavailable rather than escalating the permission.
 */
async function getActivePageUrl(): Promise<string> {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tabs[0]?.url ?? '';
  } catch (err) {
    console.warn('[Pipeline Tracker side panel] activeTab url unavailable:', err);
    return '';
  }
}

/** onSave for the capture card — the typed manual-capture enqueue (decision 1).
 * Throws OutboxFullError / StorageQuotaExceededError, which the capture card
 * catches to keep the card populated and show an inline error (decision 2).
 *
 * After a successful enqueue, nudge the SW with `drain_outbox` so it broadcasts
 * `new-events` to any connected app tab and the webapp auto-pulls (sync-pull →
 * sync-ack) without the user clicking Sync. Spec 016 deleted content.ts, which
 * used to fire this post-capture; the manual save path must carry it forward or
 * auto-sync silently stops. The nudge runs only on a clean enqueue (a thrown
 * quota/full-outbox error short-circuits it) and its own failure is swallowed —
 * the save already succeeded, so it must not surface the card's inline error. */
export async function saveManualCapture(capture: ManualCaptureInput): Promise<void> {
  await enqueueManualCapture(capture);
  try {
    await chrome.runtime.sendMessage({ kind: 'drain_outbox' });
  } catch (err) {
    console.warn('[Pipeline Tracker side panel] post-save drain nudge failed:', err);
  }
}

/** "<first> <last>" from settings — the owner identity used to tell our own
 * messages apart in a captured thread. '' when neither is configured. */
function ownerNameFromSettings(settings: Settings): string {
  return [settings.owner_first_name, settings.owner_last_name]
    .map((s) => (s ?? '').trim())
    .filter(Boolean)
    .join(' ');
}

/** Resolve the owner name for the deterministic message/stage pass. Best-effort:
 * a corrupted settings read degrades to '' (the pass then no-ops). */
async function getOwnerNameForCapture(): Promise<string> {
  try {
    return ownerNameFromSettings(await readSettingsOrDefault());
  } catch {
    return '';
  }
}

/**
 * Spec 016 Phase 2 — on-device AI extraction for the capture card. Promotes the
 * generalized `extractContact()` (formerly the AI fallback) to the
 * primary repair path. Gated on the user's `ai_fallback_enabled` opt-in AND
 * model availability; returns null otherwise so the heuristic values stand. The
 * pipeline is raw → capFragment (multi-MB parser guard) → stripHtmlForCarry
 * (≤16KB content budget) → model.
 *
 * NEVER throws (D-AI-1): any error degrades to null (heuristic prefill stays).
 * The stripped HTML is fed to the model only — it is NEVER persisted (decision 3
 * keeps the save path on setOutboxAndHistory, no recovered_html).
 */
async function aiExtractForCapture(input: {
  html?: string;
  text?: string;
  candidate: ContactFields;
}): Promise<AiExtractionResult | AiTimeout | AiTooLarge | null> {
  // Verbose tracing — every early-exit announces itself so an AI extraction that
  // silently degrades to the heuristic is never invisible. Gated on the user's
  // opt-in debug_logging setting (some lines echo the candidate fields).
  const TAG = '[Pipeline Tracker AI]';
  try {
    const settings = await readSettingsOrDefault();
    const debug = settings.debug_logging ?? false;
    const dbg = (...args: unknown[]): void => {
      if (debug) console.log(TAG, ...args);
    };
    dbg('aiExtractForCapture START', {
      hasHtml: Boolean(input.html),
      hasText: Boolean(input.text),
      candidate: input.candidate,
    });

    if (!settings.ai_fallback_enabled) {
      dbg('EXIT: ai_fallback_enabled is OFF — enable the AI toggle in Settings.');
      return null;
    }

    const availability = await getCachedAvailability();
    if (availability !== 'available') {
      dbg(`EXIT: model availability is "${availability}" (need "available").`);
      return null;
    }

    const raw = input.html || input.text || '';
    if (!raw.trim()) {
      dbg('EXIT: dragged/pasted fragment is empty after trim.');
      return null;
    }
    const stripped = stripHtmlForCarryWithStatus(capFragment(raw));
    if (stripped.tooLarge) {
      dbg('EXIT: stripped HTML exceeds cap — input too large for AI, skipping.');
      return { tooLarge: true };
    }
    const trimmedHtml = stripped.html;
    if (!trimmedHtml) {
      dbg('EXIT: fragment stripped to empty (capFragment/stripHtmlForCarry).');
      return null;
    }

    // Owner name (from the first-run modal) lets the extractor identify which
    // messages in a captured thread are ours. Empty ⇒ prompt falls back cleanly.
    const ownerName = ownerNameFromSettings(settings);

    dbg(`calling extractContact (trimmedHtml ${trimmedHtml.length} chars)`);
    const result = await extractContact({
      trimmedHtml,
      candidate: input.candidate,
      pageUrl: '',
      ownerName,
      debug,
    });
    if (!result) {
      dbg('EXIT: extractContact returned null — see [extractContact] logs above for why.');
      return null;
    }
    if ('timedOut' in result) {
      dbg('EXIT: extractContact TIMED OUT — surfacing warning to the card.');
      return { timedOut: true };
    }
    if ('tooLarge' in result) {
      dbg('EXIT: extractContact reported INPUT TOO LARGE — surfacing warning.');
      return { tooLarge: true };
    }
    dbg('SUCCESS: extractContact returned', result);
    return { fields: result.fields, suggested_event_type: result.suggested_event_type };
  } catch (err) {
    console.warn('[Pipeline Tracker side panel] AI extraction errored — using heuristic:', err);
    return null;
  }
}

// Cached mirror of settings.debug_logging. Seeded in initSidePanel and refreshed
// by the settings `update` wrapper, so the sync debugLogCaptureFragment callback
// can gate on it without an async storage read on every drop. Default OFF.
let _debugLogging = false;

/**
 * Sample-collection logger (spec 016 prompt tuning). Fires on EVERY drop/paste —
 * regardless of AI toggle, model availability, or heuristic confidence — and
 * logs both the raw fragment and the exact stripped content that WOULD be sent
 * to the model (raw → capFragment → stripHtmlForCarry). Use the side panel's own
 * DevTools console to copy these out as test fixtures.
 *
 * Gated on the user's opt-in `debug_logging` setting: the raw fragment can carry
 * private message content, so this is silent unless the user enabled it.
 */
function debugLogCaptureFragment(frag: { html?: string; text?: string }): void {
  if (!_debugLogging) return;
  const raw = frag.html || frag.text || '';
  const trimmedHtml = raw.trim() ? stripHtmlForCarry(capFragment(raw)) : '';
  console.log('[Pipeline Tracker capture] DROP — raw fragment', {
    htmlLength: frag.html?.length ?? 0,
    textLength: frag.text?.length ?? 0,
    html: frag.html ?? null,
    text: frag.text ?? null,
  });
  console.log(
    `[Pipeline Tracker capture] DROP — LLM-bound content (${trimmedHtml.length} chars):\n` +
      trimmedHtml,
  );
}

let _captureHandle: CaptureSectionHandle | null = null;

function mountCaptureSection(root: HTMLElement): void {
  if (_captureHandle) {
    _captureHandle.destroy();
    _captureHandle = null;
  }
  try {
    _captureHandle = renderCaptureSection(root, {
      onSave: saveManualCapture,
      getPageUrl: getActivePageUrl,
      getOwnerName: getOwnerNameForCapture,
      aiExtract: aiExtractForCapture,
      debugLogFragment: debugLogCaptureFragment,
    });
  } catch (err) {
    console.error('[Pipeline Tracker side panel] mountCaptureSection failed:', err);
  }
}

export async function initSidePanel(): Promise<void> {
  const settingsRoot = document.getElementById('settings-section') as HTMLElement;
  const bindingRoot = document.getElementById('binding-section') as HTMLElement;
  const captureRoot = document.getElementById('capture-section') as HTMLElement | null;
  const reviewRoot = document.getElementById('review-section') as HTMLElement;
  const unsyncedList = document.getElementById('unsynced-list') as HTMLElement;
  const unsyncedCount = document.getElementById('unsynced-count') as HTMLElement;
  const syncNowBtn = document.getElementById('sync-now-btn') as HTMLButtonElement | null;
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
  // Seed the cached debug flag for the sync capture logger (refreshed on toggle).
  _debugLogging = settings.debug_logging ?? false;

  // Render events + clear the unread badge BEFORE the modal. Two reasons:
  //   (1) Phase 5 invariant — opening the panel always repaints the toolbar
  //       badge. Deferring this behind the modal would mean a user reading the
  //       disclosure sees the badge still painted as unread.
  //   (2) If the modal hangs (commit keeps failing AND user never clicks
  //       Skip), initSidePanel must still resolve with a usable surface —
  //       events visible, badge cleared.
  const renderedUnsynced = renderUnsynced(unsyncedList, unsyncedCount, outbox, {
    captureMessageBodies,
    onEdit: editUnsyncedEntry,
    onDelete: deleteUnsyncedEntry,
  });
  toggleSyncButton(syncNowBtn, renderedUnsynced);
  renderActivity(activityList, history, { captureMessageBodies });
  // Spec 015 B2 — review queue for low-confidence captures. Empty → renders
  // nothing, so the section is invisible until something needs attention.
  if (reviewRoot) renderReview(reviewRoot, outbox);
  // Spec 016 — manual drag/paste capture card. Mounts independently of binding
  // and storage state; captures queue into the outbox even before binding.
  if (captureRoot) mountCaptureSection(captureRoot);
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

  // "Sync" button — opens the tracker tab, which pulls the outbox in realtime
  // while it stays open. Same deep link as the binding "Open CareerSystems"
  // CTA. Visibility is toggled by toggleSyncButton as the outbox changes.
  if (syncNowBtn) {
    syncNowBtn.addEventListener('click', () => {
      defaultOpenAppTab();
    });
  }

  // Keep the unsynced events list in sync when the SW wipes the outbox
  // (delete-outbox rebind choice) or any other code mutates OUTBOX.
  // Without this listener the panel shows stale rows until next open.
  safelyMountUnsyncedListener(unsyncedList, unsyncedCount, captureMessageBodies, syncNowBtn);

  // Keep the activity list in sync when sync-ack (or any other writer)
  // flips HISTORY entries from 'pending' → 'ok'. Without this the panel
  // keeps showing "Queued — waiting to send" until the panel is reopened.
  safelyMountActivityListener(activityList, captureMessageBodies);

  // Spec 015 B2 — keep the review queue live after Save / Sync actions mutate
  // OUTBOX (via the SW) and after new low-confidence captures land.
  if (reviewRoot) safelyMountReviewListener(reviewRoot);

  // Binding section mounts independently of the first-run modal: a user
  // can read the disclosure with the section visible behind it (the
  // overlay catches clicks so they cannot interact until the modal is
  // closed). Subscribing to storage.onChanged here means bind-ack flips
  // from the SW reach the panel without any polling. Wrapped in a
  // best-effort to preserve Phase 6's "modal/events must still render
  // even if a subtree fails" invariant. modalRoot is passed in for the
  // Phase 8 rebind 3-choice modal (D-rev-19).
  // spec 016 UI — only the compact "Connected as <email>" status lives on the
  // main panel now; the full sync (connect/disconnect) controls moved into the
  // Settings dropdown (mounted below, after the first-run modal).
  mountConnectedIndicator(bindingRoot, binding);

  // Mount the modal asynchronously. We deliberately do NOT await it inside
  // initSidePanel — see (2) above. The settings section is mounted only
  // AFTER the modal commits (or is skipped), so the user can't toggle
  // capture_message_bodies via the settings UI before they've seen the
  // disclosure. A modal mount error logs + drops the settings section for
  // this open; the user will see the modal again next session. The CareerSystems
  // sync controls render inside that settings section (mountSettings).
  void maybeShowFirstRunModal(modalRoot, settings)
    .then((finalSettings) => mountSettings(settingsRoot, finalSettings, binding, modalRoot))
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
