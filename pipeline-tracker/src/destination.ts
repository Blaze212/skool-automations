// Spec 012 Phase 4 — DestinationStrategy.
//
// Internal and publishable builds share scraping, validation, outbox enqueue,
// and history/badge wiring. They differ ONLY in where captured events go:
//   - Internal:   drained automatically to `pipeline-tracker-webhook`.
//   - Publishable: sit in the outbox until app.cmcareersystems.com pulls them
//                  via the externally_connectable sync handlers (Phases 9-10).
//
// This file encapsulates that destination difference. background.ts wires one
// strategy per SW spin-up based on the BUILD_TARGET define injected by
// build.ts. Both strategies implement the same hooks; only the webhook one
// reaches the network.
//
// CI guard #3 (`guard:no-fetch-in-publishable`) backstops the BUILD_TARGET
// gate by grepping the publishable bundle for `fetch(`/`XMLHttpRequest` after
// build. Any residual leaves the bundle and trips CI before submission.

import {
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_STALE_AFTER_MS,
  STORAGE_KEYS,
  type PipelineEvent,
  type Severity,
} from './types.ts';
import { deliveryStore, outboxStore } from './storage.ts';
import { ts } from './logger.ts';

// Build-target sentinel — injected by build.ts via esbuild `define`. The
// publishable bundle has RESOLVED_BUILD_TARGET === 'publishable', so the webhook delivery
// branch is `if (false)` after substitution and esbuild's minifySyntax pass
// folds it out. defense-in-depth alongside the CI guard.
declare const BUILD_TARGET: 'internal' | 'publishable';

// Same defensive fallback as background.ts — if a future tool path imports
// this module without the esbuild `define`, evaluating the bare identifier in
// a method body would throw ReferenceError at call time. typeof keeps the
// runtime alive and routes to the safer internal default.
const RESOLVED_BUILD_TARGET: 'internal' | 'publishable' =
  typeof BUILD_TARGET === 'undefined' ? 'internal' : BUILD_TARGET;

declare const PIPELINE_TRACKER_WEBHOOK_URL: string;

const tag = () => `[Pipeline Tracker Destination - ${ts()}]`;

export interface Classified {
  status: Severity;
  message: string;
  code?: string;
  http_status?: number;
  warnings?: string[];
}

export interface DeliveryOutcome {
  classified: Classified;
  /** true if this was a network/timeout failure — leave the outbox entry for retry. */
  transientFailure: boolean;
}

/**
 * Callback the destination invokes when an outbox entry's terminal classification
 * is known (success, partial, hard failure, exhausted retries, stale-dropped).
 * Lives in background.ts because both this strategy AND the publishable sync-ack
 * handler resolve history rows the same way — keeping the resolver out here would
 * fork that behavior between builds.
 */
export type ResolveHistoryFn = (
  event: PipelineEvent,
  classified: Classified,
  historyId: string | null,
) => Promise<void>;

export interface DestinationStrategy {
  /**
   * Hook fired when content enqueues an event. Internal: kicks off a drain.
   * Publishable: no-op (events sit until app.cmcareersystems.com pulls them).
   *
   * NOTE — Phase 4 wires the existing content → `{kind:'drain_outbox'}`
   * message to `drainNow()` only; `onEventCaptured` is part of the interface
   * contract but is not yet invoked from background.ts. Phase 9 changes the
   * externally_connectable surface and will route per-event hooks here as
   * the architecture in spec 012 §Architecture lays out. Tests exercise both
   * shapes to keep that future wiring honest.
   */
  onEventCaptured(event: PipelineEvent, historyId: string): Promise<void>;
  /** Explicit drain trigger from onAlarm, onStartup, onInstalled, restoreBadgeOnStartup. */
  drainNow(): Promise<void>;
}

// ─── Webhook delivery (internal build only) ────────────────────────────────
//
// performWebhookDelivery is the ONLY place fetch() appears in the codebase.
// It is reached exclusively from WebhookAutoPushStrategy methods, and every
// caller is gated on `BUILD_TARGET === 'internal'` so esbuild's minifySyntax
// can prove the call is dead in the publishable bundle and DCE the function.

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

// ─── Strategies ────────────────────────────────────────────────────────────

export interface WebhookStrategyDeps {
  resolveHistory: ResolveHistoryFn;
}

export class WebhookAutoPushStrategy implements DestinationStrategy {
  private _draining = false;
  private readonly resolveHistory: ResolveHistoryFn;

  constructor(deps: WebhookStrategyDeps) {
    this.resolveHistory = deps.resolveHistory;
  }

  /** Test-only — drop the in-progress latch so a fresh drain runs. */
  _resetDrainingForTests(): void {
    this._draining = false;
  }

  async onEventCaptured(_event: PipelineEvent, _historyId: string): Promise<void> {
    await this.drainNow();
  }

  /**
   * Direct-delivery path for the popup's "Test connection" button (internal
   * build only). Returns the outcome inline rather than going through the
   * outbox + drain loop. handleMessage in background.ts narrows to this
   * strategy concrete type before calling.
   */
  async deliverEventDirect(event: PipelineEvent): Promise<DeliveryOutcome> {
    if (RESOLVED_BUILD_TARGET === 'publishable') {
      // Unreachable after esbuild minifySyntax substitution in the publishable
      // bundle; kept as a runtime guard for non-bundled test paths.
      return {
        classified: { status: 'error', message: 'webhook delivery unavailable in this build' },
        transientFailure: false,
      };
    }
    return performWebhookDelivery(event);
  }

  async drainNow(): Promise<void> {
    if (RESOLVED_BUILD_TARGET === 'publishable') {
      // Same DCE story as deliverEventDirect — never reached in the bundled
      // publishable build, retained for test paths that load this module raw.
      return;
    }
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

export class AppSyncStrategy implements DestinationStrategy {
  // Publishable build: nothing happens at capture or alarm time. The outbox
  // sits until app.cmcareersystems.com calls sync-pull via externally_connectable
  // (wired up in Phases 9-10).
  async onEventCaptured(_event: PipelineEvent, _historyId: string): Promise<void> {
    // no-op
  }
  async drainNow(): Promise<void> {
    // no-op
  }
}
