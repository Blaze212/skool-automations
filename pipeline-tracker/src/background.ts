declare const PIPELINE_TRACKER_WEBHOOK_URL: string;

import {
  BADGE_COLOR_ERROR,
  BADGE_COLOR_OK,
  BADGE_COLOR_PARTIAL,
  BADGE_TEXT_COLOR,
  BADGE_TEXT_ERROR,
  BADGE_TEXT_OK,
  BADGE_TEXT_PARTIAL,
  HISTORY_CAP,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_STALE_AFTER_MS,
  STORAGE_KEYS,
  type HistoryEntry,
  type OutboxEntry,
  type PipelineEvent,
  type Severity,
} from './types.ts';

console.log(
  '[Pipeline Tracker BG] service worker started, webhook URL configured:',
  !!PIPELINE_TRACKER_WEBHOOK_URL,
);

interface BackgroundResult {
  ok: boolean;
  message?: string;
}

interface Classified {
  status: Severity;
  message: string;
  code?: string;
  http_status?: number;
  warnings?: string[];
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
  const local = (await chrome.storage.local.get([STORAGE_KEYS.LAST_STATUS])) as Record<
    string,
    unknown
  >;
  const lastStatus = local[STORAGE_KEYS.LAST_STATUS] as Severity | undefined;
  if (!lastStatus) {
    await chrome.action.setBadgeText({ text: '' });
  } else {
    await applyBadge(lastStatus);
  }
  // Drain any events that piled up while the worker was asleep / browser closed.
  // Fire-and-forget with explicit .catch — a bubbled rejection here would become
  // an unhandled rejection in the SW global, which can wedge the worker.
  drainOutbox().catch((err: unknown) => {
    console.error('[Pipeline Tracker BG] drainOutbox (restoreBadgeOnStartup) threw:', err);
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
 */
async function recordResolved(
  event: PipelineEvent,
  classified: Classified,
  historyId: string | null,
): Promise<void> {
  const local = (await chrome.storage.local.get([
    STORAGE_KEYS.HISTORY,
    STORAGE_KEYS.UNREAD_COUNT,
    STORAGE_KEYS.HIGHEST_SEVERITY,
  ])) as Record<string, unknown>;

  const prevHistory = (local[STORAGE_KEYS.HISTORY] as HistoryEntry[] | undefined) ?? [];
  const prevUnread = (local[STORAGE_KEYS.UNREAD_COUNT] as number | undefined) ?? 0;
  const prevSeverity = (local[STORAGE_KEYS.HIGHEST_SEVERITY] as Severity | undefined) ?? 'ok';

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

  await chrome.storage.local.set({
    [STORAGE_KEYS.HISTORY]: history,
    [STORAGE_KEYS.UNREAD_COUNT]: unreadCount,
    [STORAGE_KEYS.HIGHEST_SEVERITY]: highestSeverity,
    [STORAGE_KEYS.LAST_STATUS]: lastStatus,
  });

  await applyBadge(lastStatus);
}

// --- Delivery ---

interface DeliveryOutcome {
  classified: Classified;
  /** true if this was a network/timeout failure — leave the outbox entry for retry. */
  transientFailure: boolean;
}

async function deliverEvent(event: PipelineEvent): Promise<DeliveryOutcome> {
  const now = new Date().toISOString();

  if (!PIPELINE_TRACKER_WEBHOOK_URL) {
    console.error('[Pipeline Tracker BG] PIPELINE_TRACKER_WEBHOOK_URL is not set');
    return {
      classified: { status: 'error', message: 'Webhook URL not configured' },
      transientFailure: false,
    };
  }

  const syncData = await chrome.storage.sync.get(STORAGE_KEYS.API_KEY);
  const apiKey = (syncData as Record<string, unknown>)[STORAGE_KEYS.API_KEY] as string | undefined;

  if (!apiKey) {
    console.warn('[Pipeline Tracker BG] No api_key configured; skipping POST');
    return {
      classified: { status: 'error', message: 'No api_key configured' },
      transientFailure: false,
    };
  }

  const payload: PipelineEvent = { ...event, api_key: apiKey };
  console.log('[Pipeline Tracker BG] POSTing to webhook:', JSON.stringify(payload));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(PIPELINE_TRACKER_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      let code: string | undefined;
      let serverMessage: string | undefined;
      try {
        const parsed = JSON.parse(bodyText) as { error?: string; code?: string };
        code = parsed.code;
        serverMessage = parsed.error;
      } catch {
        // non-JSON body; ignore
      }
      console.error(`[Pipeline Tracker BG] POST failed ${res.status}:`, bodyText);
      await chrome.storage.local.set({ [STORAGE_KEYS.LAST_ERROR]: now });

      let message: string;
      if (res.status === 403) {
        message = 'Sheet not shared or invalid API key';
      } else if (serverMessage) {
        message = serverMessage;
      } else {
        message = 'Connection failed. Check your key.';
      }
      return {
        classified: { status: 'error', message, code, http_status: res.status },
        transientFailure: false,
      };
    }

    console.log('[Pipeline Tracker BG] POST succeeded');
    await chrome.storage.local.set({
      [STORAGE_KEYS.LAST_LOGGED_AT]: now,
      [STORAGE_KEYS.LAST_ERROR]: null,
    });

    const bodyText = await res.text().catch(() => '');
    let warnings: string[] = [];
    try {
      const parsed = JSON.parse(bodyText) as { warnings?: unknown };
      if (Array.isArray(parsed.warnings)) {
        warnings = parsed.warnings.filter((w): w is string => typeof w === 'string');
      }
    } catch {
      // non-JSON body; ignore
    }

    const status: Severity = warnings.length > 0 ? 'partial' : 'ok';
    const message = warnings.length > 0 ? `Logged with warnings: ${warnings.join(', ')}` : 'Logged';
    return {
      classified: { status, message, http_status: res.status, warnings },
      transientFailure: false,
    };
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof Error && err.name === 'AbortError') {
      console.warn('[Pipeline Tracker BG] POST timed out');
      await chrome.storage.local.set({ [STORAGE_KEYS.LAST_ERROR]: now });
      return {
        classified: { status: 'error', message: 'Connection timed out' },
        transientFailure: true,
      };
    }
    console.error('[Pipeline Tracker BG] POST threw:', err);
    await chrome.storage.local.set({ [STORAGE_KEYS.LAST_ERROR]: now });
    return {
      classified: { status: 'error', message: 'Connection failed' },
      transientFailure: true,
    };
  }
}

// --- Outbox drain ---

let _draining = false;

export async function drainOutbox(): Promise<void> {
  if (_draining) {
    console.log('[Pipeline Tracker BG] drain already in progress, skipping');
    return;
  }
  _draining = true;
  try {
    while (true) {
      const local = (await chrome.storage.local.get(STORAGE_KEYS.OUTBOX)) as Record<
        string,
        unknown
      >;
      const outbox = (local[STORAGE_KEYS.OUTBOX] as OutboxEntry[] | undefined) ?? [];
      if (outbox.length === 0) return;

      const entry = outbox[0];
      const ageMs = Date.now() - new Date(entry.enqueued_at).getTime();
      const stale = ageMs > OUTBOX_STALE_AFTER_MS;

      if (stale) {
        await recordResolved(
          entry.event,
          {
            status: 'error',
            message: 'Dropped — event was queued more than 7 days ago',
          },
          entry.history_id,
        );
        await popOutboxHead(entry.history_id);
        continue;
      }

      const updatedAttempts = entry.attempts + 1;
      const outcome = await deliverEvent(entry.event);

      if (outcome.transientFailure && updatedAttempts <= OUTBOX_MAX_ATTEMPTS) {
        // Leave at head with incremented attempts; stop draining so we don't hammer.
        await bumpOutboxHeadAttempts(entry.history_id, updatedAttempts);
        return;
      }

      if (outcome.transientFailure && updatedAttempts > OUTBOX_MAX_ATTEMPTS) {
        await recordResolved(
          entry.event,
          {
            status: 'error',
            message: `Dropped after ${OUTBOX_MAX_ATTEMPTS} retries — check connection`,
          },
          entry.history_id,
        );
        await popOutboxHead(entry.history_id);
        continue;
      }

      // Non-transient: success, partial, or hard failure. Resolve and remove.
      await recordResolved(entry.event, outcome.classified, entry.history_id);
      await popOutboxHead(entry.history_id);
    }
  } finally {
    _draining = false;
  }
}

async function popOutboxHead(historyId: string): Promise<void> {
  const local = (await chrome.storage.local.get(STORAGE_KEYS.OUTBOX)) as Record<string, unknown>;
  const outbox = (local[STORAGE_KEYS.OUTBOX] as OutboxEntry[] | undefined) ?? [];
  const next = outbox.filter((e) => e.history_id !== historyId);
  await chrome.storage.local.set({ [STORAGE_KEYS.OUTBOX]: next });
}

async function bumpOutboxHeadAttempts(historyId: string, attempts: number): Promise<void> {
  const local = (await chrome.storage.local.get(STORAGE_KEYS.OUTBOX)) as Record<string, unknown>;
  const outbox = (local[STORAGE_KEYS.OUTBOX] as OutboxEntry[] | undefined) ?? [];
  const next = outbox.map((e) => (e.history_id === historyId ? { ...e, attempts } : e));
  await chrome.storage.local.set({ [STORAGE_KEYS.OUTBOX]: next });
}

// --- Message handling ---

export async function handleMessage(msg: BgMessage): Promise<BackgroundResult> {
  if ('kind' in msg && msg.kind === 'drain_outbox') {
    console.log('[Pipeline Tracker BG] drain_outbox requested');
    await drainOutbox();
    return { ok: true };
  }

  // Legacy / popup-test path: caller sent a raw event and expects a synchronous result.
  // Don't enqueue — just deliver and record directly so the popup's Test button gets
  // the ok/message back inline.
  const event = msg as PipelineEvent;
  console.log(
    '[Pipeline Tracker BG] direct event received, type:',
    event.event_type,
    'name:',
    event.name,
  );
  const outcome = await deliverEvent(event);
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
        console.error('[Pipeline Tracker BG] sendResponse threw on success path:', err);
      }
    },
    (err) => {
      console.error('[Pipeline Tracker BG] handleMessage rejected:', err);
      const message =
        err instanceof Error ? err.message : 'Background handler failed with non-Error throw';
      try {
        sendResponse({ ok: false, message });
      } catch (sendErr) {
        console.error('[Pipeline Tracker BG] sendResponse threw on error path:', sendErr);
      }
    },
  );
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  console.log('[Pipeline Tracker BG] onMessage listener fired');
  onMessageHandler(msg as BgMessage, sendResponse);
  return true;
});

if (chrome.runtime.onStartup && typeof chrome.runtime.onStartup.addListener === 'function') {
  chrome.runtime.onStartup.addListener(() => {
    console.log('[Pipeline Tracker BG] onStartup — draining outbox');
    drainOutbox().catch((err: unknown) => {
      console.error('[Pipeline Tracker BG] drainOutbox (onStartup) threw:', err);
    });
  });
}

if (chrome.runtime.onInstalled && typeof chrome.runtime.onInstalled.addListener === 'function') {
  chrome.runtime.onInstalled.addListener(() => {
    console.log('[Pipeline Tracker BG] onInstalled — draining outbox');
    drainOutbox().catch((err: unknown) => {
      console.error('[Pipeline Tracker BG] drainOutbox (onInstalled) threw:', err);
    });
  });
}

restoreBadgeOnStartup().catch((err: unknown) => {
  console.error('[Pipeline Tracker BG] restoreBadgeOnStartup threw:', err);
});

// --- Service worker keep-alive ---
//
// MV3 terminates the SW after ~30s of idle. That alone isn't catastrophic
// (Chrome restarts the SW on the next event), but the wake can race or fail
// outright — when that happens, content.ts's sendMessage rejects with
// "Could not establish connection" and the event sits in the outbox until the
// next user action. We narrow that window with an alarm that wakes the SW and
// opportunistically drains the outbox.
//
// Chrome enforces a 1-minute minimum periodInMinutes for installed extensions
// (https://developer.chrome.com/docs/extensions/reference/api/alarms):
//   "For installed extensions, anything less than 1 minute is treated as 1 minute."
// So we set the minimum value the API will actually honor; the 30-second
// residual gap between alarm fires and SW idle timeout is covered by the
// content-script's sendMessage retry-with-backoff (defense in depth).
//
// chrome.alarms.create is documented to "cancel and replace" an existing alarm
// with the same name, so calling it at module top-level on every SW startup
// (cold start, after crash, after browser restart) is the correct way to
// guarantee the alarm is always live — no chrome.alarms.clear needed first.
//
// onAlarm listener is registered at module top-level so it survives SW
// restarts (MV3 listener-registration requirement).
const KEEP_ALIVE_ALARM = 'pipeline-tracker-keep-alive';

if (chrome.alarms && typeof chrome.alarms.create === 'function') {
  try {
    chrome.alarms.create(KEEP_ALIVE_ALARM, {
      // 1-minute minimum per Chrome docs; smaller values are silently clamped.
      delayInMinutes: 1,
      periodInMinutes: 1,
    });
  } catch (err) {
    console.error('[Pipeline Tracker BG] failed to register keep-alive alarm:', err);
  }
}

if (chrome.alarms?.onAlarm && typeof chrome.alarms.onAlarm.addListener === 'function') {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== KEEP_ALIVE_ALARM) return;
    // Receiving the alarm itself wakes the SW — even a no-op listener body
    // would be enough. We additionally drain the outbox so events that hit a
    // dead-SW window get flushed without waiting for the user.
    drainOutbox().catch((err: unknown) => {
      console.error('[Pipeline Tracker BG] drainOutbox (keep-alive) threw:', err);
    });
  });
}
