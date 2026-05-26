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
  STORAGE_KEYS,
  type HistoryEntry,
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

function severityRank(s: Severity): number {
  return s === 'error' ? 2 : s === 'partial' ? 1 : 0;
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

async function recordResult(event: PipelineEvent, classified: Classified): Promise<void> {
  const local = (await chrome.storage.local.get([
    STORAGE_KEYS.HISTORY,
    STORAGE_KEYS.UNREAD_COUNT,
    STORAGE_KEYS.HIGHEST_SEVERITY,
  ])) as Record<string, unknown>;

  const prevHistory = (local[STORAGE_KEYS.HISTORY] as HistoryEntry[] | undefined) ?? [];
  const prevUnread = (local[STORAGE_KEYS.UNREAD_COUNT] as number | undefined) ?? 0;
  const prevSeverity = (local[STORAGE_KEYS.HIGHEST_SEVERITY] as Severity | undefined) ?? 'ok';

  const lastStatus = effectiveSeverity(event, classified);

  const entry: HistoryEntry = {
    ts: new Date().toISOString(),
    status: lastStatus,
    event_type: event.event_type,
    name: event.name,
    page_url: event.page_url,
    message: classified.message,
    warnings: classified.warnings ?? [],
    code: classified.code,
    http_status: classified.http_status,
  };

  const history = [entry, ...prevHistory].slice(0, HISTORY_CAP);

  const isNoisy = lastStatus !== 'ok';
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

async function applyBadge(severity: Severity): Promise<void> {
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
  // setBadgeTextColor isn't on every Chrome build; guard it.
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
  // No prior event yet → no badge. Once an event lands the bubble appears.
  if (!lastStatus) {
    await chrome.action.setBadgeText({ text: '' });
    return;
  }
  await applyBadge(lastStatus);
}

export async function handleMessage(event: PipelineEvent): Promise<BackgroundResult> {
  console.log(
    '[Pipeline Tracker BG] onMessage received, type:',
    event.event_type,
    'name:',
    event.name,
  );

  if (!PIPELINE_TRACKER_WEBHOOK_URL) {
    console.error(
      '[Pipeline Tracker BG] PIPELINE_TRACKER_WEBHOOK_URL is not set — rebuild with env var',
    );
    const message = 'Webhook URL not configured';
    await recordResult(event, { status: 'error', message });
    return { ok: false, message };
  }

  const syncData = await chrome.storage.sync.get(STORAGE_KEYS.API_KEY);
  const apiKey = (syncData as Record<string, unknown>)[STORAGE_KEYS.API_KEY] as string | undefined;

  if (!apiKey) {
    console.warn('[Pipeline Tracker BG] No api_key configured; skipping POST');
    const message = 'No api_key configured';
    await recordResult(event, { status: 'error', message });
    return { ok: false, message };
  }

  const payload: PipelineEvent = { ...event, api_key: apiKey };
  const now = new Date().toISOString();
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
      await recordResult(event, {
        status: 'error',
        message,
        code,
        http_status: res.status,
      });
      return { ok: false, message };
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
    await recordResult(event, { status, message, http_status: res.status, warnings });
    return { ok: true };
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof Error && err.name === 'AbortError') {
      console.warn('[Pipeline Tracker BG] POST timed out');
      await chrome.storage.local.set({ [STORAGE_KEYS.LAST_ERROR]: now });
      const message = 'Connection timed out';
      await recordResult(event, { status: 'error', message });
      return { ok: false, message };
    }
    console.error('[Pipeline Tracker BG] POST threw:', err);
    await chrome.storage.local.set({ [STORAGE_KEYS.LAST_ERROR]: now });
    const message = 'Connection failed';
    await recordResult(event, { status: 'error', message });
    return { ok: false, message };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  console.log('[Pipeline Tracker BG] onMessage listener fired');
  void handleMessage(msg as PipelineEvent).then(sendResponse);
  return true;
});

void restoreBadgeOnStartup();
