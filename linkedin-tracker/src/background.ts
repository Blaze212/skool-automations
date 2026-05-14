declare const LINKEDIN_TRACKER_WEBHOOK_URL: string;

import { STORAGE_KEYS, type TrackerEvent } from './types.ts';

console.log(
  '[LinkedIn Tracker BG] service worker started, webhook URL configured:',
  !!LINKEDIN_TRACKER_WEBHOOK_URL,
);

export async function handleMessage(
  event: TrackerEvent,
): Promise<{ ok: boolean; message?: string }> {
  console.log(
    '[LinkedIn Tracker BG] onMessage received, type:',
    event.message_type,
    'name:',
    event.name,
  );

  if (!LINKEDIN_TRACKER_WEBHOOK_URL) {
    console.error(
      '[LinkedIn Tracker BG] LINKEDIN_TRACKER_WEBHOOK_URL is not set — rebuild with env var',
    );
    return { ok: false, message: 'Webhook URL not configured' };
  }

  const syncData = await chrome.storage.sync.get(STORAGE_KEYS.API_KEY);
  const apiKey = (syncData as Record<string, unknown>)[STORAGE_KEYS.API_KEY] as string | undefined;

  if (!apiKey) {
    console.warn('[LinkedIn Tracker BG] No api_key configured; skipping POST');
    return { ok: false, message: 'No api_key configured' };
  }

  const payload: TrackerEvent = { ...event, api_key: apiKey };
  const now = new Date().toISOString();
  console.log('[LinkedIn Tracker BG] POSTing to webhook:', JSON.stringify(payload));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(LINKEDIN_TRACKER_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[LinkedIn Tracker BG] POST failed ${res.status}:`, body);
      await chrome.storage.local.set({ [STORAGE_KEYS.LAST_ERROR]: now });
      if (res.status === 403) {
        return { ok: false, message: 'Sheet not shared' };
      }
      return { ok: false, message: 'Connection failed. Check your key.' };
    }

    console.log('[LinkedIn Tracker BG] POST succeeded');
    await chrome.storage.local.set({
      [STORAGE_KEYS.LAST_LOGGED_AT]: now,
      [STORAGE_KEYS.LAST_ERROR]: null,
    });
    return { ok: true };
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof Error && err.name === 'AbortError') {
      console.warn('[LinkedIn Tracker BG] POST timed out');
      await chrome.storage.local.set({ [STORAGE_KEYS.LAST_ERROR]: now });
      return { ok: false, message: 'Connection timed out' };
    }
    console.error('[LinkedIn Tracker BG] POST threw:', err);
    await chrome.storage.local.set({ [STORAGE_KEYS.LAST_ERROR]: now });
    return { ok: false, message: 'Connection failed' };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  console.log('[LinkedIn Tracker BG] onMessage listener fired');
  void handleMessage(msg as TrackerEvent).then(sendResponse);
  return true;
});
