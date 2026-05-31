declare const BUILD_TARGET: 'internal' | 'publishable';

// Defensive fallback: BUILD_TARGET is injected by build.ts via esbuild's
// `define`, and by vitest.config.ts for tests. If a future tool path imports
// this module without that define (raw module loader, ad-hoc REPL, a new
// vitest config split that misses the define), accessing the bare identifier
// throws ReferenceError at module load and kills the SW before any listener
// registers. The typeof guard turns that into a safe internal-default so the
// runtime stays alive; the CI guards (#3 fetch grep + manifest split) still
// catch real misconfiguration before publish.
// `let` rather than `const` so _setBuildTargetForTests can flip it inside the
// vitest process — vitest defines BUILD_TARGET='internal' globally, so without
// the override the publishable branches (refreshPublishableBadge wiring,
// onInstalled setPanelBehavior, handleMessage drain_outbox publishable path)
// would never execute in tests. Production bundles never see the setter.
let RESOLVED_BUILD_TARGET: 'internal' | 'publishable' =
  typeof BUILD_TARGET === 'undefined' ? 'internal' : BUILD_TARGET;

/**
 * Test-only — pin the runtime build target for a single test. esbuild folds
 * the literal-equality check below into `if (true) return;` for the
 * publishable bundle (BUILD_TARGET inlines to `'publishable'`), neutralizing
 * the export at runtime so the shipped Web Store bundle cannot be coerced
 * into the internal-build strategy by anyone who reaches the SW global. The
 * function is still present in the bundle as a no-op shell, which is fine —
 * the gate it protects is now load-bearing.
 */
export function _setBuildTargetForTests(target: 'internal' | 'publishable'): void {
  if (typeof BUILD_TARGET !== 'undefined' && BUILD_TARGET === 'publishable') {
    return;
  }
  RESOLVED_BUILD_TARGET = target;
}

import {
  BADGE_COLOR_ERROR,
  BADGE_COLOR_OK,
  BADGE_COLOR_PARTIAL,
  BADGE_COLOR_PENDING,
  BADGE_TEXT_COLOR,
  BADGE_TEXT_ERROR,
  BADGE_TEXT_OK,
  BADGE_TEXT_PARTIAL,
  HISTORY_CAP,
  type HistoryEntry,
  type PipelineEvent,
  type Severity,
} from './types.ts';
import {
  badgeStore,
  ensureInitialized,
  historyStore,
  outboxStore,
  recoveredHtmlStore,
  setHistoryAndBadge,
  settingsStore,
} from './storage.ts';
import { buildCsv, getCsvFilename } from './csv.ts';
import type { Classified, DestinationStrategy } from './destination.ts';
import { createDestination } from './destination-impl.ts';
import { APP_ORIGIN, acceptAppPort, beginBinding, clearBinding } from './binding.ts';
import { handleExternalMessage } from './background-external.ts';
import { ts } from './logger.ts';

const tag = () => `[Pipeline Tracker BG - ${ts()}]`;

console.log(tag(), `service worker started, target=${RESOLVED_BUILD_TARGET}`);

interface BackgroundResult {
  ok: boolean;
  message?: string;
}

/**
 * Side-panel → background messages for the binding handshake (Phase 7,
 * publishable build). The side panel owns the 10-second rollback timer
 * (D-rev-12 SW-lifecycle note); these messages only ask the SW to mutate
 * persisted state and broadcast on its port registry.
 */
type BindingMessage =
  | { kind: 'start_binding' }
  | { kind: 'clear_binding' }
  | { kind: 'wipe_unsynced' };

type BgMessage = { kind: 'drain_outbox' } | { kind: 'export_csv' } | BindingMessage | PipelineEvent;

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

function severityRank(s: Severity): number {
  // 'pending' is intentionally lower than 'ok' for badge math — it doesn't nag.
  if (s === 'error') return 3;
  if (s === 'partial') return 2;
  if (s === 'ok') return 1;
  return 0;
}

function pickHigherSeverity(a: Severity, b: Severity): Severity {
  return severityRank(a) >= severityRank(b) ? a : b;
}

function effectiveSeverity(event: PipelineEvent, classified: Classified): Severity {
  // Red bubble when the plugin captured an event with no identifying fields,
  // even if the backend accepted it. Hides silent capture failures.
  if (!event.name?.trim() && !event.linkedin_url?.trim()) {
    return 'error';
  }
  return classified.status;
}

async function applyBadge(severity: Severity): Promise<void> {
  if (severity === 'pending') {
    // pending events do not raise the badge — popup is the signal.
    await chrome.action.setBadgeText({ text: '' });
    return;
  }
  const text =
    severity === 'error'
      ? BADGE_TEXT_ERROR
      : severity === 'partial'
        ? BADGE_TEXT_PARTIAL
        : BADGE_TEXT_OK;
  const color =
    severity === 'error'
      ? BADGE_COLOR_ERROR
      : severity === 'partial'
        ? BADGE_COLOR_PARTIAL
        : BADGE_COLOR_OK;

  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  if (typeof chrome.action.setBadgeTextColor === 'function') {
    await chrome.action.setBadgeTextColor({ color: BADGE_TEXT_COLOR });
  }
}

/**
 * Spec 012 Phase 5 / D-rev-26 — publishable badge.
 *
 * Internal build's `applyBadge` paints the badge with the latest event's
 * severity (✓ / ! / ✕). The publishable build's user-gestured drain means
 * "captured locally, not yet synced" needs a toolbar-level cue — without one
 * the user has no signal that anything is waiting for them in the app. The
 * unsynced count answers that.
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
 * Read outbox length + badge state and repaint the publishable badge. Called
 * after every signal that may have changed the unsynced count: SW spin-up,
 * `drain_outbox` messages from content (= a new capture just landed), and
 * later Phase 10's `sync-ack` removal.
 */
export async function refreshPublishableBadge(): Promise<void> {
  const [outbox, badge] = await Promise.all([outboxStore.get(), badgeStore.get()]);
  await applyPublishableBadge(outbox.length, badge.highestSeverity);
}

export async function restoreBadgeOnStartup(): Promise<void> {
  // Spec 012 D-rev-11c — every SW entry point that touches the facade must
  // await ensureInitialized first, not just handleMessage.
  await ensureInitialized();

  if (RESOLVED_BUILD_TARGET === 'publishable') {
    await refreshPublishableBadge();
    // Publishable doesn't drain — outbox sits until app.cmcareersystems.com pulls.
    return;
  }

  const { lastStatus } = await badgeStore.get();
  if (!lastStatus) {
    await chrome.action.setBadgeText({ text: '' });
  } else {
    await applyBadge(lastStatus);
  }
  // Drain any events that piled up while the worker was asleep / browser closed.
  // Fire-and-forget with explicit .catch — a bubbled rejection here would become
  // an unhandled rejection in the SW global, which can wedge the worker.
  drainOutbox().catch((err: unknown) => {
    console.error(tag(), 'drainOutbox (restoreBadgeOnStartup) threw:', err);
  });
}

/**
 * Wrap drainOutbox calls fired from non-message entry points so ensureInitialized
 * runs first. Errors are swallowed with logging — propagating into onAlarm /
 * onStartup / onInstalled would become an unhandled rejection in the SW global.
 */
function initThenDrain(source: string): Promise<void> {
  return ensureInitialized()
    .then(() => drainOutbox())
    .catch((err: unknown) => {
      console.error(tag(), `drainOutbox (${source}) threw:`, err);
    });
}

// --- Result recording ---

function newId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Resolve a previously-pending history row in place, or prepend a fresh row if
 * no matching pending row is found (e.g. popup's Test connection path).
 *
 * Exported so the WebhookAutoPushStrategy can call back into it during drain
 * (passed in as `resolveHistory` dep). Publishable's sync-ack handler (Phase
 * 10) will use the same function to mark synced rows resolved, so it stays in
 * background.ts rather than moving into one of the strategy classes.
 */
export async function recordResolved(
  event: PipelineEvent,
  classified: Classified,
  historyId: string | null,
): Promise<void> {
  const [prevHistory, badge] = await Promise.all([historyStore.get(), badgeStore.get()]);
  const prevUnread = badge.unreadCount;
  const prevSeverity = badge.highestSeverity;

  const lastStatus = effectiveSeverity(event, classified);
  const ts = new Date().toISOString();

  const resolvedEntry: HistoryEntry = {
    id: historyId ?? newId(),
    ts,
    status: lastStatus,
    event_type: event.event_type,
    name: event.name,
    page_url: event.page_url,
    message: classified.message,
    warnings: classified.warnings ?? [],
    code: classified.code,
    http_status: classified.http_status,
  };

  let history: HistoryEntry[];
  const idx = historyId ? prevHistory.findIndex((h) => h.id === historyId) : -1;
  if (idx >= 0) {
    history = [...prevHistory];
    history[idx] = resolvedEntry;
  } else {
    history = [resolvedEntry, ...prevHistory].slice(0, HISTORY_CAP);
  }

  const isNoisy = lastStatus !== 'ok' && lastStatus !== 'pending';
  const unreadCount = isNoisy ? prevUnread + 1 : prevUnread;
  const highestSeverity = isNoisy ? pickHigherSeverity(prevSeverity, lastStatus) : prevSeverity;

  // Atomic write — history + the three badge keys land in one set() call so a
  // quota failure can't leave history ahead of badge state. applyBadge() runs
  // after the storage write succeeds; if storage throws, applyBadge is skipped
  // and the throw propagates to the message-handler boundary (where we'd
  // rather surface the failure than half-update the UI).
  await setHistoryAndBadge(history, { unreadCount, highestSeverity, lastStatus });

  await applyBadge(lastStatus);
}

// --- DestinationStrategy wiring ---
//
// Constructed once per SW spin-up. Per spec 012 D-Architecture, internal builds
// auto-drain to the webhook; publishable builds wait for app.cmcareersystems.com
// to pull. The selection happens at bundle time — build.ts aliases
// `./destination-impl.ts` to destination-impl.internal.ts or
// destination-impl.publishable.ts, so the publishable graph never imports
// destination-webhook.ts and the webhook class / fetch / POST strings are
// absent from the publishable bundle. CI guard #3 backstops the alias.

const destination: DestinationStrategy = createDestination({ resolveHistory: recordResolved });

/** Test-only shim — delegates to the active strategy's reset hook. */
export function _resetDrainingForTests(): void {
  if (destination.kind === 'webhook') {
    destination._resetDrainingForTests();
  }
}

/**
 * Backwards-compatible wrapper around the strategy's drain trigger. Kept as a
 * named export because (a) the Phase 3 e2e test and the existing
 * background.test.ts both import it, (b) the keep-alive alarm / onStartup /
 * onInstalled fire-and-forget callers below stay readable.
 */
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
 *       them in publishable build).
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

  // Repaint the publishable badge so the toolbar reflects the empty outbox
  // immediately, without waiting for the next user action.
  if (RESOLVED_BUILD_TARGET === 'publishable') {
    await refreshPublishableBadge();
  }

  return {
    ok: true,
    wipedOutbox,
    wipedRecoveredHtml,
    wipedHistoryPending,
  };
}

export async function drainOutbox(): Promise<void> {
  await destination.drainNow();
}

/**
 * Spec 012 Phase 11 — CSV export (D7).
 *
 * Reads outbox + settings, fetches recovered_html for ai-recovered rows,
 * builds a CSV string, and triggers a chrome.downloads.download via a
 * data: URL. Both builds support this.
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
    if (RESOLVED_BUILD_TARGET === 'publishable') {
      // Publishable: drain is a no-op (AppSyncStrategy), but content sent this
      // because the outbox just grew. Repaint the badge so the count reflects
      // the new entry without waiting for the next SW respawn.
      await refreshPublishableBadge();
      return { ok: true };
    }
    await drainOutbox();
    return { ok: true };
  }

  if ('kind' in msg && msg.kind === 'export_csv') {
    console.log(tag(), 'export_csv requested');
    return handleExportCsv();
  }

  // Binding handshake — publishable-only. Internal build has no
  // externally_connectable, so a misrouted start_binding from a test or a
  // future mistaken caller short-circuits here with a clear message rather
  // than mutating storage. esbuild folds the RESOLVED_BUILD_TARGET branch
  // for the publishable bundle.
  if (
    'kind' in msg &&
    (msg.kind === 'start_binding' || msg.kind === 'clear_binding' || msg.kind === 'wipe_unsynced')
  ) {
    if (RESOLVED_BUILD_TARGET !== 'publishable') {
      return { ok: false, message: 'binding handshake not supported in this build' };
    }
    if (msg.kind === 'start_binding') {
      const { offer } = await beginBinding();
      const result: StartBindingResult = { ok: true, delivered: offer.delivered };
      return result;
    }
    if (msg.kind === 'wipe_unsynced') {
      return handleWipeUnsynced();
    }
    await clearBinding();
    return { ok: true };
  }

  // Legacy / popup-test path: caller sent a raw event and expects a synchronous
  // result. Internal builds deliver inline (no enqueue). Publishable builds have
  // no popup, so this path is unreachable in that bundle; the runtime guard
  // below catches accidental fan-out (e.g. a misconfigured externally_connectable
  // message that lands here).
  const event = msg as PipelineEvent;
  console.log(tag(), 'direct event received, type:', event.event_type, 'name:', event.name);

  if (destination.kind !== 'webhook') {
    return { ok: false, message: 'direct event delivery not supported in this build' };
  }
  const outcome = await destination.deliverEventDirect(event);
  await recordResolved(event, outcome.classified, null);
  return outcome.classified.status === 'ok' || outcome.classified.status === 'partial'
    ? { ok: true }
    : { ok: false, message: outcome.classified.message };
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
    console.log(tag(), 'onStartup — draining outbox');
    void initThenDrain('onStartup');
  });
}

if (chrome.runtime.onInstalled && typeof chrome.runtime.onInstalled.addListener === 'function') {
  chrome.runtime.onInstalled.addListener(() => {
    console.log(tag(), 'onInstalled — draining outbox');
    void initThenDrain('onInstalled');

    // Spec 012 Phase 5 — publishable build requires setPanelBehavior to be
    // called from code, not the manifest, for the toolbar icon to open the
    // side panel (Chrome docs note older `openPanelOnActionClick` manifest
    // field never shipped). Without this the toolbar icon does nothing in
    // the publishable build. Internal build has no sidePanel permission and
    // uses a popup, so the guard skips it (and the property is undefined
    // anyway under that manifest, which would throw without the typeof
    // check).
    if (
      RESOLVED_BUILD_TARGET === 'publishable' &&
      typeof chrome.sidePanel?.setPanelBehavior === 'function'
    ) {
      chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err: unknown) => {
        console.error(tag(), 'setPanelBehavior failed:', err);
      });
    }
  });
}

restoreBadgeOnStartup().catch((err: unknown) => {
  console.error(tag(), 'restoreBadgeOnStartup threw:', err);
});

// --- Binding handshake port listener (publishable only) ---
//
// Spec 012 Phase 7 / D-rev-12. App page opens a long-lived port to us; we
// validate the sender, key the port by sender.tab.id, and on subsequent
// bind-offer broadcasts we postMessage over each one. The port listener is
// registered at module top-level so it survives SW restarts (MV3 listener-
// registration requirement). Internal build has no externally_connectable
// in its manifest, so the listener never fires there even when registered,
// but the BUILD_TARGET gate keeps the module-load side effect off entirely
// for that bundle (defensive — also keeps the publishable-only `binding.ts`
// import out of the internal bundle path graph).
if (
  RESOLVED_BUILD_TARGET === 'publishable' &&
  chrome.runtime.onConnectExternal &&
  typeof chrome.runtime.onConnectExternal.addListener === 'function'
) {
  chrome.runtime.onConnectExternal.addListener((port) => {
    // acceptAppPort does its own sender + name validation, disconnects on
    // rejection, and wires the per-port onMessage / onDisconnect listeners.
    // Nothing more for us to do at this layer — defense in depth lives
    // inside the binding module.
    acceptAppPort(port);
  });
}

// --- External message handler (publishable only) ---
//
// Spec 012 Phase 9. App page calls chrome.runtime.sendMessage (NOT a port) for
// ping + sync-pull — short-lived one-shot calls, not the long-lived port used
// for the binding handshake. The listener validates origin synchronously and
// returns false (close channel) on mismatch; valid messages are dispatched to
// handleExternalMessage which re-validates origin (defense in depth) before
// routing.
if (
  RESOLVED_BUILD_TARGET === 'publishable' &&
  chrome.runtime.onMessageExternal &&
  typeof chrome.runtime.onMessageExternal.addListener === 'function'
) {
  chrome.runtime.onMessageExternal.addListener(
    (msg: unknown, sender: chrome.runtime.MessageSender, sendResponse: (r: unknown) => void) => {
      // Reject invalid origins synchronously so Chrome closes the channel
      // immediately rather than leaving a dead async channel open.
      if (sender.origin !== APP_ORIGIN) {
        console.warn(
          tag(),
          `external message rejected — wrong origin: ${sender.origin ?? 'undefined'}`,
        );
        return false;
      }
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

// --- Service worker keep-alive (internal build only) ---
//
// MV3 terminates the SW after ~30s of idle. That alone isn't catastrophic
// (Chrome restarts the SW on the next event), but the wake can race or fail
// outright — when that happens, content.ts's sendMessage rejects with
// "Could not establish connection" and the event sits in the outbox until the
// next user action. We narrow that window with an alarm that wakes the SW and
// opportunistically drains the outbox.
//
// Publishable builds don't carry the `alarms` permission and don't auto-drain
// (events sit until the app pulls), so the alarm registration is gated on
// BUILD_TARGET. esbuild collapses the `if` branch in the publishable bundle.
//
// chrome.alarms.create is documented to "cancel and replace" an existing alarm
// with the same name, so calling it at module top-level on every SW startup
// (cold start, after crash, after browser restart) is the correct way to
// guarantee the alarm is always live — no chrome.alarms.clear needed first.
//
// onAlarm listener is registered at module top-level so it survives SW
// restarts (MV3 listener-registration requirement).
const KEEP_ALIVE_ALARM = 'pipeline-tracker-keep-alive';

if (RESOLVED_BUILD_TARGET === 'internal') {
  if (chrome.alarms && typeof chrome.alarms.create === 'function') {
    try {
      chrome.alarms.create(KEEP_ALIVE_ALARM, {
        // 1-minute minimum per Chrome docs; smaller values are silently clamped.
        delayInMinutes: 1,
        periodInMinutes: 1,
      });
    } catch (err) {
      console.error(tag(), 'failed to register keep-alive alarm:', err);
    }
  }

  if (chrome.alarms?.onAlarm && typeof chrome.alarms.onAlarm.addListener === 'function') {
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name !== KEEP_ALIVE_ALARM) return;
      // Receiving the alarm itself wakes the SW — even a no-op listener body
      // would be enough. We additionally drain the outbox so events that hit a
      // dead-SW window get flushed without waiting for the user.
      void initThenDrain('keep-alive');
    });
  }
}
