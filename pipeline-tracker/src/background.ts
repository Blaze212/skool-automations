declare const PIPELINE_TRACKER_WEBHOOK_URL: string;
declare const BUILD_TARGET: 'internal' | 'publishable';

// Defensive fallback: BUILD_TARGET is injected by build.ts via esbuild's
// `define`, and by vitest.config.ts for tests. If a future tool path imports
// this module without that define (raw module loader, ad-hoc REPL, a new
// vitest config split that misses the define), accessing the bare identifier
// throws ReferenceError at module load and kills the SW before any listener
// registers. The typeof guard turns that into a safe internal-default so the
// runtime stays alive; the CI guards (#3 fetch grep + manifest split) still
// catch real misconfiguration before publish.
const RESOLVED_BUILD_TARGET: 'internal' | 'publishable' =
  typeof BUILD_TARGET === 'undefined' ? 'internal' : BUILD_TARGET;

import {
  BADGE_COLOR_ERROR,
  BADGE_COLOR_OK,
  BADGE_COLOR_PARTIAL,
  BADGE_TEXT_COLOR,
  BADGE_TEXT_ERROR,
  BADGE_TEXT_OK,
  BADGE_TEXT_PARTIAL,
  HISTORY_CAP,
  type HistoryEntry,
  type PipelineEvent,
  type Severity,
} from './types.ts';
import { badgeStore, ensureInitialized, historyStore, setHistoryAndBadge } from './storage.ts';
import {
  AppSyncStrategy,
  WebhookAutoPushStrategy,
  type Classified,
  type DestinationStrategy,
} from './destination.ts';
import { ts } from './logger.ts';

const tag = () => `[Pipeline Tracker BG - ${ts()}]`;

console.log(
  tag(),
  `service worker started, target=${RESOLVED_BUILD_TARGET}, webhook URL configured:`,
  !!PIPELINE_TRACKER_WEBHOOK_URL,
);

interface BackgroundResult {
  ok: boolean;
  message?: string;
}

type BgMessage = { kind: 'drain_outbox' } | PipelineEvent;

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

export async function restoreBadgeOnStartup(): Promise<void> {
  // Spec 012 D-rev-11c — every SW entry point that touches the facade must
  // await ensureInitialized first, not just handleMessage.
  await ensureInitialized();
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
// to pull. BUILD_TARGET is injected by build.ts via esbuild `define`, so the
// branch below collapses at build time and the publishable bundle contains
// only the AppSyncStrategy path (CI guard #3 verifies no fetch leaks through).

const destination: DestinationStrategy =
  RESOLVED_BUILD_TARGET === 'publishable'
    ? new AppSyncStrategy()
    : new WebhookAutoPushStrategy({ resolveHistory: recordResolved });

/** Test-only shim — delegates to the active strategy's reset hook. */
export function _resetDrainingForTests(): void {
  if (destination instanceof WebhookAutoPushStrategy) {
    destination._resetDrainingForTests();
  }
}

/**
 * Backwards-compatible wrapper around the strategy's drain trigger. Kept as a
 * named export because (a) the Phase 3 e2e test and the existing
 * background.test.ts both import it, (b) the keep-alive alarm / onStartup /
 * onInstalled fire-and-forget callers below stay readable.
 */
export async function drainOutbox(): Promise<void> {
  await destination.drainNow();
}

// --- Message handling ---

export async function handleMessage(msg: BgMessage): Promise<BackgroundResult> {
  // Spec 012 D-rev-11c: every SW spin-up fills missing storage keys with
  // defaults before any handler logic touches them. Idempotent across spin-ups.
  await ensureInitialized();

  if ('kind' in msg && msg.kind === 'drain_outbox') {
    console.log(tag(), 'drain_outbox requested');
    await drainOutbox();
    return { ok: true };
  }

  // Legacy / popup-test path: caller sent a raw event and expects a synchronous
  // result. Internal builds deliver inline (no enqueue). Publishable builds have
  // no popup, so this path is unreachable in that bundle; the runtime guard
  // below catches accidental fan-out (e.g. a misconfigured externally_connectable
  // message that lands here).
  const event = msg as PipelineEvent;
  console.log(tag(), 'direct event received, type:', event.event_type, 'name:', event.name);

  if (!(destination instanceof WebhookAutoPushStrategy)) {
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
  });
}

restoreBadgeOnStartup().catch((err: unknown) => {
  console.error(tag(), 'restoreBadgeOnStartup threw:', err);
});

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
