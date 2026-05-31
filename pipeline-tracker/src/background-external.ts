// Spec 012 Phase 9 — onMessageExternal ping + sync-pull handlers (publishable build).
//
// Registered in background.ts at module load (publishable only). Origin is
// validated as the FIRST step — defense in depth alongside
// externally_connectable.matches in the manifest (D-rev-27). On mismatch
// handleExternalMessage returns null and the listener does NOT call
// sendResponse, so Chrome closes the channel silently.
//
// ping: short-lived presence/status probe used by the app to decide whether to
// show the "Connect Extension" prompt and, once connected, how many events are
// waiting. The response shape varies by binding state.
//
// sync-pull: idempotent read of the outbox — returns every pending PipelineEvent
// with recovered_html lazily attached (D-rev-28). No mutations; Phase 10 lands
// sync-ack which triggers the atomic removals.

import {
  bindingStore,
  ensureInitialized,
  historyStore,
  outboxStore,
  recoveredHtmlStore,
  resolveOutboxBatch,
} from './storage.ts';
import type { PipelineEvent } from './types.ts';
import { APP_ORIGIN } from './binding.ts';
import { ts } from './logger.ts';

const tag = () => `[Pipeline Tracker External - ${ts()}]`;

// --- External message wire types ---

export interface PingExternalMessage {
  type: 'ping';
  bindingToken?: string;
}

export interface SyncPullExternalMessage {
  type: 'sync-pull';
  bindingToken: string;
}

function isPingMessage(msg: unknown): msg is PingExternalMessage {
  if (!msg || typeof msg !== 'object') return false;
  return (msg as Record<string, unknown>).type === 'ping';
}

function isSyncPullMessage(msg: unknown): msg is SyncPullExternalMessage {
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as Record<string, unknown>;
  return m.type === 'sync-pull' && typeof m.bindingToken === 'string';
}

// --- Response shapes (D-rev-27) ---

export type PingUnboundResponse = { version: string; installed: true };
export type PingBoundResponse = {
  version: string;
  installed: true;
  eventCount: number;
  unsyncedCount: number;
  bound: true;
};
export type PingBadTokenResponse = { installed: true; bound: false };
export type PingResponse = PingUnboundResponse | PingBoundResponse | PingBadTokenResponse;

export interface SyncPullNotBound {
  error: 'NOT_BOUND';
}
export interface SyncPullRows {
  rows: PipelineEvent[];
  syncedIds: string[];
}
export type SyncPullResponse = SyncPullNotBound | SyncPullRows;

export interface SyncAckExternalMessage {
  type: 'sync-ack';
  bindingToken: string;
  syncedIds: string[];
}

function isSyncAckMessage(msg: unknown): msg is SyncAckExternalMessage {
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as Record<string, unknown>;
  return (
    m.type === 'sync-ack' &&
    typeof m.bindingToken === 'string' &&
    Array.isArray(m.syncedIds) &&
    (m.syncedIds as unknown[]).every((id) => typeof id === 'string')
  );
}

export interface SyncAckNotBound {
  error: 'NOT_BOUND';
}
export interface SyncAckSuccess {
  ackedCount: number;
}
export type SyncAckResponse = SyncAckNotBound | SyncAckSuccess;

export type ExternalMessageResponse = PingResponse | SyncPullResponse | SyncAckResponse;

// --- Handlers ---

async function handlePing(msg: PingExternalMessage): Promise<PingResponse> {
  const { version } = chrome.runtime.getManifest() as { version: string };
  const binding = await bindingStore.get();

  if (!binding || binding.status !== 'confirmed') {
    // Unbound (no binding or still pending) — reveal version so the app can
    // display "extension installed, not yet linked" messaging (D-rev-27).
    return { version, installed: true };
  }
  if (msg.bindingToken !== binding.token) {
    // Binding exists but presented token is wrong or absent — do NOT reveal
    // the version since the caller doesn't hold the token (D-rev-27).
    return { installed: true, bound: false };
  }

  const [outbox, history] = await Promise.all([outboxStore.get(), historyStore.get()]);
  return {
    version,
    installed: true,
    eventCount: history.length,
    unsyncedCount: outbox.length,
    bound: true,
  };
}

async function handleSyncPull(msg: SyncPullExternalMessage): Promise<SyncPullResponse> {
  const binding = await bindingStore.get();
  if (!binding || binding.status !== 'confirmed' || binding.token !== msg.bindingToken) {
    return { error: 'NOT_BOUND' };
  }

  const outbox = await outboxStore.get();
  const syncedIds: string[] = [];
  const rows: PipelineEvent[] = [];

  for (const entry of outbox) {
    // D-rev-28: attach recovered_html lazily from the per-id keyed store.
    // Stays null/absent until spec 013 ships the AI-fallback writer.
    const html = await recoveredHtmlStore.get(entry.history_id);
    const event: PipelineEvent = { ...entry.event };
    if (html !== null) {
      event.recovered_html = html;
    }
    rows.push(event);
    syncedIds.push(entry.history_id);
  }

  console.log(tag(), `sync-pull: rows=${rows.length}`);
  return { rows, syncedIds };
}

async function handleSyncAck(
  msg: SyncAckExternalMessage,
  deps: { refreshBadge?: () => Promise<void> },
): Promise<SyncAckResponse> {
  const binding = await bindingStore.get();
  if (!binding || binding.status !== 'confirmed' || binding.token !== msg.bindingToken) {
    return { error: 'NOT_BOUND' };
  }

  const { ackedCount } = await resolveOutboxBatch(msg.syncedIds);

  console.log(tag(), `sync-ack: syncedIds=${msg.syncedIds.length}, ackedCount=${ackedCount}`);

  if (deps.refreshBadge) {
    await deps.refreshBadge();
  }

  return { ackedCount };
}

/**
 * Dispatch an external message from app.cmcareersystems.com.
 *
 * Validates sender.origin first — returns null to suppress sendResponse on
 * origin mismatch or unknown message type. The listener in background.ts
 * also fast-rejects on origin mismatch synchronously (return false) so
 * this second check is defense in depth.
 */
export async function handleExternalMessage(
  msg: unknown,
  sender: chrome.runtime.MessageSender,
  deps: { refreshBadge?: () => Promise<void> } = {},
): Promise<ExternalMessageResponse | null> {
  if (sender.origin !== APP_ORIGIN) {
    console.warn(
      tag(),
      `external message rejected — wrong origin: ${sender.origin ?? 'undefined'}`,
    );
    return null;
  }

  // D-rev-11c: fill any missing storage defaults before touching stores.
  await ensureInitialized();

  if (isPingMessage(msg)) {
    return handlePing(msg);
  }
  if (isSyncPullMessage(msg)) {
    return handleSyncPull(msg);
  }
  if (isSyncAckMessage(msg)) {
    return handleSyncAck(msg, deps);
  }

  console.warn(tag(), 'unknown external message type:', msg);
  return null;
}
