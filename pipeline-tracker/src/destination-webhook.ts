// Spec 012 Phase 4 follow-up — internal-build webhook destination.
//
// This file holds the ONLY fetch() call in the extension and is intentionally
// never imported by the publishable build. destination-impl.ts is aliased at
// bundle time (build.ts onResolve plugin) to destination-impl.publishable.ts
// for publishable, which imports destination-appsync.ts instead — so this
// module, its `WebhookAutoPushStrategy` class, `performWebhookDelivery`, and
// every "POST"/"webhook" string literal in here are absent from the
// publishable bundle. CI guard #3 (`guard:no-fetch-in-publishable`) backstops
// the alias.

import {
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_STALE_AFTER_MS,
  STORAGE_KEYS,
  type PipelineEvent,
  type Severity,
} from './types.ts';
import { deliveryStore, outboxStore } from './storage.ts';
import { ts } from './logger.ts';
import type {
  Classified,
  DeliveryOutcome,
  ResolveHistoryFn,
  WebhookDestination,
  WebhookStrategyDeps,
} from './destination.ts';

declare const PIPELINE_TRACKER_WEBHOOK_URL: string;

const tag = () => `[Pipeline Tracker Webhook - ${ts()}]`;

async function performWebhookDelivery(event: PipelineEvent): Promise<DeliveryOutcome> {
  const now = new Date().toISOString();

  if (!PIPELINE_TRACKER_WEBHOOK_URL) {
    console.error(tag(), 'PIPELINE_TRACKER_WEBHOOK_URL is not set');
    return {
      classified: { status: 'error', message: 'Webhook URL not configured' },
      transientFailure: false,
    };
  }

  const syncData = await chrome.storage.sync.get(STORAGE_KEYS.API_KEY);
  const apiKey = (syncData as Record<string, unknown>)[STORAGE_KEYS.API_KEY] as string | undefined;

  if (!apiKey) {
    console.warn(tag(), 'No api_key configured; skipping POST');
    return {
      classified: { status: 'error', message: 'No api_key configured' },
      transientFailure: false,
    };
  }

  const payload: PipelineEvent = { ...event, api_key: apiKey };
  console.log(tag(), 'POSTing to webhook:', JSON.stringify(payload));

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
      console.error(tag(), `POST failed ${res.status}:`, bodyText);
      await deliveryStore.setLastError(now);

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

    console.log(tag(), 'POST succeeded');
    // Atomic — clear any prior lastError alongside writing the new lastLoggedAt
    // so the popup never shows contradictory "Last logged" + "Last POST failed"
    // lines if the second write fails.
    await deliveryStore.setLastLoggedAndClearError(now);

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
      console.warn(tag(), 'POST timed out');
      await deliveryStore.setLastError(now);
      return {
        classified: { status: 'error', message: 'Connection timed out' },
        transientFailure: true,
      };
    }
    console.error(tag(), 'POST threw:', err);
    await deliveryStore.setLastError(now);
    return {
      classified: { status: 'error', message: 'Connection failed' },
      transientFailure: true,
    };
  }
}

async function popOutboxHead(historyId: string): Promise<void> {
  const outbox = await outboxStore.get();
  await outboxStore.set(outbox.filter((e) => e.history_id !== historyId));
}

async function bumpOutboxHeadAttempts(historyId: string, attempts: number): Promise<void> {
  const outbox = await outboxStore.get();
  await outboxStore.set(outbox.map((e) => (e.history_id === historyId ? { ...e, attempts } : e)));
}

export class WebhookAutoPushStrategy implements WebhookDestination {
  readonly kind = 'webhook' as const;
  private _draining = false;
  private readonly resolveHistory: ResolveHistoryFn;

  constructor(deps: WebhookStrategyDeps) {
    this.resolveHistory = deps.resolveHistory;
  }

  _resetDrainingForTests(): void {
    this._draining = false;
  }

  async onEventCaptured(_event: PipelineEvent, _historyId: string): Promise<void> {
    await this.drainNow();
  }

  async deliverEventDirect(event: PipelineEvent): Promise<DeliveryOutcome> {
    return performWebhookDelivery(event);
  }

  async drainNow(): Promise<void> {
    if (this._draining) {
      console.log(tag(), 'drain already in progress, skipping');
      return;
    }
    this._draining = true;
    try {
      while (true) {
        const outbox = await outboxStore.get();
        if (outbox.length === 0) return;

        const entry = outbox[0];
        const ageMs = Date.now() - new Date(entry.enqueued_at).getTime();
        const stale = ageMs > OUTBOX_STALE_AFTER_MS;

        if (stale) {
          await this.resolveHistory(
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
        const outcome = await performWebhookDelivery(entry.event);

        if (outcome.transientFailure && updatedAttempts <= OUTBOX_MAX_ATTEMPTS) {
          // Leave at head with incremented attempts; stop draining so we don't hammer.
          await bumpOutboxHeadAttempts(entry.history_id, updatedAttempts);
          return;
        }

        if (outcome.transientFailure && updatedAttempts > OUTBOX_MAX_ATTEMPTS) {
          await this.resolveHistory(
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
        await this.resolveHistory(entry.event, outcome.classified, entry.history_id);
        await popOutboxHead(entry.history_id);
      }
    } finally {
      this._draining = false;
    }
  }
}
