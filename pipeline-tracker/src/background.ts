// Pipeline Tracker service worker (spec 015 — unified single build).
//
// Spec 090/015 C7 retired the internal/publishable BUILD_TARGET split: there is
// now ONE build, behaving as the former "publishable" external build. Events are
// captured into the outbox and pulled by app.cmcareersystems.com over
// externally_connectable (binding handshake + sync-pull/sync-ack). The SW never
// initiates a webhook POST — internal pipeline behavior is now server-side via
// tracker_clients.sheet_layout, so no per-build webhook/alarm/popup code remains.

import {
  BADGE_COLOR_ERROR,
  BADGE_COLOR_OK,
  BADGE_COLOR_PARTIAL,
  BADGE_COLOR_PENDING,
  BADGE_TEXT_COLOR,
  BADGE_TEXT_ERROR,
  BADGE_TEXT_PARTIAL,
  type Severity,
} from './types.ts';
import {
  badgeStore,
  ensureInitialized,
  historyStore,
  outboxStore,
  recoveredHtmlStore,
  settingsStore,
} from './storage.ts';
import { buildCsv, getCsvFilename } from './csv.ts';
import {
  ALLOWED_ORIGINS,
  acceptAppPort,
  beginBinding,
  broadcastNewEvents,
  clearBinding,
  getAppPortCount,
} from './binding.ts';
import { handleExternalMessage } from './background-external.ts';
import { ts } from './logger.ts';

const tag = () => `[Pipeline Tracker BG - ${ts()}]`;

console.log(tag(), `service worker started, extensionId=${chrome.runtime.id}`);

interface BackgroundResult {
  ok: boolean;
  message?: string;
}

/**
 * Side-panel → background messages for the binding handshake (Phase 7). The
 * side panel owns the 10-second rollback timer (D-rev-12 SW-lifecycle note);
 * these messages only ask the SW to mutate persisted state and broadcast on
 * its port registry.
 */
type BindingMessage =
  | { kind: 'start_binding' }
  | { kind: 'clear_binding' }
  | { kind: 'wipe_unsynced' };

type BgMessage = { kind: 'drain_outbox' } | { kind: 'export_csv' } | BindingMessage;

interface StartBindingResult extends BackgroundResult {
  /** Number of app tabs the bind-offer reached. 0 → side panel shows "Open CareerSystems first" (Phase 8). */
  delivered?: number;
}

interface WipeUnsyncedResult extends BackgroundResult {
  /** How many outbox entries were destroyed (for UX confirmation logs). */
  wipedOutbox?: number;
  /** How many recovered_html_* keys were destroyed (includes orphans). */
  wipedRecoveredHtml?: number;
  /** How many pending HistoryEntry rows were removed. */
  wipedHistoryPending?: number;
}

/**
 * Spec 012 Phase 5 / D-rev-26 — toolbar badge.
 *
 * The user-gestured (pull-based) sync means "captured locally, not yet synced"
 * needs a toolbar-level cue — without one the user has no signal that anything
 * is waiting for them in the app. The unsynced count answers that.
 *
 * Precedence (spec 007 still wins for noisy states):
 *   - highestSeverity === 'error'   → ✕ in BADGE_COLOR_ERROR (storage quota,
 *                                       extraction blow-up, etc.)
 *   - highestSeverity === 'partial' → ! in BADGE_COLOR_PARTIAL
 *   - otherwise                     → unsyncedCount (text) in BADGE_COLOR_PENDING,
 *                                       blank when zero
 */
async function applyPublishableBadge(
  unsyncedCount: number,
  highestSeverity: Severity,
): Promise<void> {
  if (highestSeverity === 'error' || highestSeverity === 'partial') {
    const text = highestSeverity === 'error' ? BADGE_TEXT_ERROR : BADGE_TEXT_PARTIAL;
    const color = highestSeverity === 'error' ? BADGE_COLOR_ERROR : BADGE_COLOR_PARTIAL;
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
    if (typeof chrome.action.setBadgeTextColor === 'function') {
      await chrome.action.setBadgeTextColor({ color: BADGE_TEXT_COLOR });
    }
    return;
  }
  if (unsyncedCount <= 0) {
    await chrome.action.setBadgeText({ text: '' });
    return;
  }
  await chrome.action.setBadgeText({ text: String(unsyncedCount) });
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR_PENDING });
  if (typeof chrome.action.setBadgeTextColor === 'function') {
    await chrome.action.setBadgeTextColor({ color: BADGE_TEXT_COLOR });
  }
}

/**
 * Read outbox length + badge state and repaint the toolbar badge. Called after
 * every signal that may have changed the unsynced count: SW spin-up,
 * `drain_outbox` messages from content (= a new capture just landed), and
 * `sync-ack` removals.
 */
export async function refreshPublishableBadge(): Promise<void> {
  const [outbox, badge] = await Promise.all([outboxStore.get(), badgeStore.get()]);
  await applyPublishableBadge(outbox.length, badge.highestSeverity);
}

export async function restoreBadgeOnStartup(): Promise<void> {
  // Spec 012 D-rev-11c — every SW entry point that touches the facade must
  // await ensureInitialized first, not just handleMessage.
  await ensureInitialized();
  await refreshPublishableBadge();
  // No autonomous drain — the outbox sits until app.cmcareersystems.com pulls.
}

/**
 * Spec 012 Phase 8 / D-rev-19 — handles the side panel's "delete the
 * unsynced events" choice from the rebind 3-choice modal. Routes the wipe
 * through the SW so:
 *
 *   (a) the snapshot is read FRESH inside the SW — a content-script
 *       capture racing the user's modal interaction can't drop into the
 *       wipe-gap and survive (Phase 8 review angle A/B finding).
 *   (b) recovered_html_* keys are enumerated globally — including orphans
 *       that no longer have a matching outbox entry — so a prior user's
 *       HTML bytes can't leak to a different CareerSystems user signing
 *       in on the same Chrome profile.
 *   (c) pending HistoryEntry rows that point at the wiped outbox entries
 *       are also removed, so the Recent activity strip doesn't show
 *       sticky "pending" rows forever (no other writer ever resolves
 *       them until the app syncs).
 *   (d) the side panel doesn't need to import recoveredHtmlStore — the
 *       sidepanel.ts header invariant (D-rev-30: side panel never touches
 *       recovered_html) stays intact.
 */
async function handleWipeUnsynced(): Promise<WipeUnsyncedResult> {
  const outboxSnapshot = await outboxStore.get();
  const wipedOutbox = outboxSnapshot.length;
  const pendingIds = new Set(outboxSnapshot.map((e) => e.history_id));

  // Order matters: filter+write history BEFORE outbox so a SW crash between
  // can't leave pending history rows pointing at a missing outbox. Then
  // outbox. Then recovered_html — orphan cleanup is safe last because by
  // then both outbox and history are already consistent.
  const history = await historyStore.get();
  const survivingHistory = history.filter((h) => !(h.status === 'pending' && pendingIds.has(h.id)));
  const wipedHistoryPending = history.length - survivingHistory.length;
  if (wipedHistoryPending > 0) {
    await historyStore.set(survivingHistory);
  }

  if (wipedOutbox > 0) {
    await outboxStore.set([]);
  }

  // Enumerate + remove every recovered_html_* key, not just the ones whose
  // history_id appears in the outbox snapshot. Orphan keys from prior
  // partial syncs (SW evicted between setOutboxHistoryAndRecoveredHtml and
  // a follow-up outbox write) live here too.
  const wipedRecoveredHtml = await recoveredHtmlStore.removeAll();

  console.log(
    tag(),
    `wipe_unsynced complete: outbox=${wipedOutbox}, recovered_html=${wipedRecoveredHtml}, history_pending=${wipedHistoryPending}`,
  );

  // Repaint the badge so the toolbar reflects the empty outbox immediately,
  // without waiting for the next user action.
  await refreshPublishableBadge();

  return {
    ok: true,
    wipedOutbox,
    wipedRecoveredHtml,
    wipedHistoryPending,
  };
}

/**
 * Spec 012 Phase 11 — CSV export (D7).
 *
 * Reads outbox + settings, fetches recovered_html for ai-recovered rows,
 * builds a CSV string, and triggers a chrome.downloads.download via a
 * data: URL.
 *
 * D-rev-30: this handler is the ONLY place that reads recovered_html for
 * export — the side panel never touches it.
 */
async function handleExportCsv(): Promise<BackgroundResult> {
  const [outbox, settings] = await Promise.all([outboxStore.get(), settingsStore.get()]);

  const recoveredHtmlMap: Record<string, string | null> = {};
  const aiRows = outbox.filter((e) => (e.event.source ?? 'selectors') === 'ai-recovered');
  if (aiRows.length > 0) {
    await Promise.all(
      aiRows.map(async (entry) => {
        recoveredHtmlMap[entry.history_id] = await recoveredHtmlStore.get(entry.history_id);
      }),
    );
  }

  const csv = buildCsv(outbox, recoveredHtmlMap, settings.capture_message_bodies);
  const dataUrl = `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
  const filename = getCsvFilename(new Date());

  await chrome.downloads.download({ url: dataUrl, filename });
  return { ok: true };
}

// --- Message handling ---

export async function handleMessage(msg: BgMessage): Promise<BackgroundResult> {
  // Spec 012 D-rev-11c: every SW spin-up fills missing storage keys with
  // defaults before any handler logic touches them. Idempotent across spin-ups.
  await ensureInitialized();

  if ('kind' in msg && msg.kind === 'drain_outbox') {
    console.log(tag(), 'drain_outbox requested');
    // Drain is pull-based: content sent this because the outbox just grew.
    // Repaint the badge so the count reflects the new entry without waiting
    // for the next SW respawn.
    await refreshPublishableBadge();
    // Notify any connected app tabs so they can auto-trigger sync-pull →
    // sync-ack without the user clicking Sync on the webapp.
    if (getAppPortCount() > 0) {
      const outbox = await outboxStore.get();
      if (outbox.length > 0) {
        broadcastNewEvents(outbox.length);
      }
    }
    return { ok: true };
  }

  if ('kind' in msg && msg.kind === 'export_csv') {
    console.log(tag(), 'export_csv requested');
    return handleExportCsv();
  }

  if (
    'kind' in msg &&
    (msg.kind === 'start_binding' || msg.kind === 'clear_binding' || msg.kind === 'wipe_unsynced')
  ) {
    if (msg.kind === 'start_binding') {
      const { offer } = await beginBinding();
      if (offer.delivered === 0) {
        console.warn(
          tag(),
          `start_binding: no connected app ports — webapp may be calling chrome.runtime.connect() with the wrong extension ID. This extension's ID is: ${chrome.runtime.id}`,
        );
      }
      const result: StartBindingResult = { ok: true, delivered: offer.delivered };
      return result;
    }
    if (msg.kind === 'wipe_unsynced') {
      return handleWipeUnsynced();
    }
    await clearBinding();
    return { ok: true };
  }

  console.warn(tag(), 'unknown background message:', msg);
  return { ok: false, message: 'unknown message' };
}

/**
 * Wrap any background-side handler so an unhandled rejection (a) becomes a
 * proper sendResponse to the caller instead of "the port closed silently",
 * and (b) doesn't bubble out into the SW global as an unhandled rejection,
 * which can leave the worker in a state where Chrome won't auto-revive it.
 */
export function onMessageHandler(
  msg: BgMessage,
  sendResponse: (response: BackgroundResult) => void,
): void {
  handleMessage(msg).then(
    (result) => {
      try {
        sendResponse(result);
      } catch (err) {
        console.error(tag(), 'sendResponse threw on success path:', err);
      }
    },
    (err) => {
      console.error(tag(), 'handleMessage rejected:', err);
      const message =
        err instanceof Error ? err.message : 'Background handler failed with non-Error throw';
      try {
        sendResponse({ ok: false, message });
      } catch (sendErr) {
        console.error(tag(), 'sendResponse threw on error path:', sendErr);
      }
    },
  );
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  console.log(tag(), 'onMessage listener fired');
  onMessageHandler(msg as BgMessage, sendResponse);
  return true;
});

if (chrome.runtime.onStartup && typeof chrome.runtime.onStartup.addListener === 'function') {
  chrome.runtime.onStartup.addListener(() => {
    console.log(tag(), 'onStartup — refreshing badge');
    restoreBadgeOnStartup().catch((err: unknown) => {
      console.error(tag(), 'restoreBadgeOnStartup (onStartup) threw:', err);
    });
  });
}

if (chrome.runtime.onInstalled && typeof chrome.runtime.onInstalled.addListener === 'function') {
  chrome.runtime.onInstalled.addListener(() => {
    console.log(tag(), 'onInstalled — refreshing badge');
    restoreBadgeOnStartup().catch((err: unknown) => {
      console.error(tag(), 'restoreBadgeOnStartup (onInstalled) threw:', err);
    });

    // Spec 012 Phase 5 — setPanelBehavior must be called from code, not the
    // manifest, for the toolbar icon to open the side panel (Chrome docs note
    // the older `openPanelOnActionClick` manifest field never shipped).
    // Without this the toolbar icon does nothing.
    if (typeof chrome.sidePanel?.setPanelBehavior === 'function') {
      chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err: unknown) => {
        console.error(tag(), 'setPanelBehavior failed:', err);
      });
    }
  });
}

restoreBadgeOnStartup().catch((err: unknown) => {
  console.error(tag(), 'restoreBadgeOnStartup threw:', err);
});

// --- Binding handshake port listener ---
//
// Spec 012 Phase 7 / D-rev-12. App page opens a long-lived port to us; we
// validate the sender, key the port by sender.tab.id, and on subsequent
// bind-offer broadcasts we postMessage over each one. The port listener is
// registered at module top-level so it survives SW restarts (MV3 listener-
// registration requirement).
if (
  chrome.runtime.onConnectExternal &&
  typeof chrome.runtime.onConnectExternal.addListener === 'function'
) {
  chrome.runtime.onConnectExternal.addListener((port) => {
    console.log(
      tag(),
      `onConnectExternal fired — name=${port.name}, origin=${port.sender?.origin ?? 'undefined'}, tabId=${port.sender?.tab?.id ?? 'undefined'}`,
    );
    const accepted = acceptAppPort(port);
    if (accepted) {
      // SW may have respawned since the last port connection, wiping appPorts.
      // If events queued while the SW was dead, notify immediately so the webapp
      // can sync without waiting for the next capture.
      void outboxStore.get().then((outbox) => {
        if (outbox.length > 0) {
          console.log(
            tag(),
            `onConnectExternal: found ${outbox.length} queued event(s) — broadcasting new-events`,
          );
          broadcastNewEvents(outbox.length);
        }
      });
    }
  });
}

// --- External message handler ---
//
// Spec 012 Phase 9. App page calls chrome.runtime.sendMessage (NOT a port) for
// ping + sync-pull — short-lived one-shot calls, not the long-lived port used
// for the binding handshake. The listener validates origin synchronously and
// returns false (close channel) on mismatch; valid messages are dispatched to
// handleExternalMessage which re-validates origin (defense in depth) before
// routing.
if (
  chrome.runtime.onMessageExternal &&
  typeof chrome.runtime.onMessageExternal.addListener === 'function'
) {
  chrome.runtime.onMessageExternal.addListener(
    (msg: unknown, sender: chrome.runtime.MessageSender, sendResponse: (r: unknown) => void) => {
      // Reject invalid origins synchronously so Chrome closes the channel
      // immediately rather than leaving a dead async channel open.
      const msgType =
        msg && typeof msg === 'object' && 'type' in msg
          ? (msg as Record<string, unknown>).type
          : 'unknown';
      if (!ALLOWED_ORIGINS.has(sender.origin ?? '')) {
        console.warn(
          tag(),
          `onMessageExternal rejected — origin=${sender.origin ?? 'undefined'}, type=${String(msgType)}`,
        );
        return false;
      }
      console.log(
        tag(),
        `onMessageExternal accepted — origin=${sender.origin ?? 'undefined'}, type=${String(msgType)}`,
      );
      handleExternalMessage(msg, sender, { refreshBadge: refreshPublishableBadge }).then(
        (result) => {
          if (result === null) return; // unknown type — no response
          try {
            sendResponse(result);
          } catch (err) {
            console.error(tag(), 'sendResponse threw on external message path:', err);
          }
        },
        (err) => {
          console.error(tag(), 'handleExternalMessage rejected:', err);
        },
      );
      return true; // will respond asynchronously
    },
  );
}
