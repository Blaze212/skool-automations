declare const LINKEDIN_TRACKER_WEBHOOK_URL: string;

import { STORAGE_KEYS, type TrackerEvent } from './types.ts';

console.log(
  '[LinkedIn Tracker BG] service worker started, webhook URL configured:',
  !!LINKEDIN_TRACKER_WEBHOOK_URL,
);

export async function handleMessage(event: TrackerEvent): Promise<void> {
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
    return;
  }

  const syncData = await chrome.storage.sync.get(STORAGE_KEYS.API_KEY);
  const apiKey = (syncData as Record<string, unknown>)[STORAGE_KEYS.API_KEY] as string | undefined;

  if (!apiKey) {
    console.warn('[LinkedIn Tracker BG] No api_key configured; skipping POST');
    return;
  }

  const payload: TrackerEvent = { ...event, api_key: apiKey };
  const now = new Date().toISOString();
  console.log('[LinkedIn Tracker BG] POSTing to webhook:', JSON.stringify(payload));

  try {
    const res = await fetch(LINKEDIN_TRACKER_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[LinkedIn Tracker BG] POST failed ${res.status}:`, body);
      await chrome.storage.local.set({ [STORAGE_KEYS.LAST_ERROR]: now });
      return;
    }

    console.log('[LinkedIn Tracker BG] POST succeeded');
    await chrome.storage.local.set({
      [STORAGE_KEYS.LAST_LOGGED_AT]: now,
      [STORAGE_KEYS.LAST_ERROR]: null,
    });
  } catch (err) {
    console.error('[LinkedIn Tracker BG] POST threw:', err);
    await chrome.storage.local.set({ [STORAGE_KEYS.LAST_ERROR]: now });
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  console.log('[LinkedIn Tracker BG] onMessage listener fired');
  void handleMessage(msg as TrackerEvent);
});
