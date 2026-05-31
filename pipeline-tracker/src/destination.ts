// Spec 012 Phase 4 — DestinationStrategy contract.
//
// This module is types-only after the Phase 4 follow-up split. Strategy
// implementations live in sibling files (destination-webhook.ts,
// destination-appsync.ts) and the per-build selector is destination-impl.ts
// (aliased at bundle time by pipeline-tracker/build.ts). Keeping the contract
// in one shared module means background.ts and tests can talk about
// strategies abstractly without forcing either bundle to import a class it
// doesn't run.
//
// The tagged-union `kind` discriminator replaced the original `instanceof`
// narrowing in background.ts. With the prior shape, the publishable bundle
// dragged WebhookAutoPushStrategy in just so the runtime `instanceof` check
// could compile — defeating the whole point of the build split. The tag lets
// background.ts narrow at runtime against a string the publishable bundle
// already knows.

import type { PipelineEvent, Severity } from './types.ts';

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
 * Lives in background.ts because both the webhook strategy AND the publishable
 * sync-ack handler resolve history rows the same way — keeping the resolver out
 * here would fork that behavior between builds.
 */
export type ResolveHistoryFn = (
  event: PipelineEvent,
  classified: Classified,
  historyId: string | null,
) => Promise<void>;

export interface WebhookStrategyDeps {
  resolveHistory: ResolveHistoryFn;
}

interface BaseDestinationStrategy {
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

export interface AppSyncDestination extends BaseDestinationStrategy {
  readonly kind: 'appsync';
}

export interface WebhookDestination extends BaseDestinationStrategy {
  readonly kind: 'webhook';
  /**
   * Direct-delivery path for the popup's "Test connection" button (internal
   * build only). Returns the outcome inline rather than going through the
   * outbox + drain loop. handleMessage in background.ts narrows on `kind`
   * before calling.
   */
  deliverEventDirect(event: PipelineEvent): Promise<DeliveryOutcome>;
  /** Test-only — drop the in-progress latch so a fresh drain runs. */
  _resetDrainingForTests(): void;
}

export type DestinationStrategy = AppSyncDestination | WebhookDestination;
