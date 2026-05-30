// Spec 012 Phase 7 — extension ↔ app binding handshake (publishable build).
//
// D3 / D-rev-2 / D-rev-8 / D-rev-12: the page-side `/api/pipeline/import` is
// authenticated by session cookie, but a separate per-install binding token
// is required to read events out of the extension over
// `externally_connectable`. Without that token, any code on
// app.cmcareersystems.com (XSS, sibling extension content script, future
// internal subpath) could call sync-pull and exfiltrate the user's full
// outreach log.
//
// The handshake itself uses a LONG-LIVED port (D-rev-12), not
// chrome.tabs.sendMessage — that keeps host_permissions limited to
// linkedin.com. The app page opens a port to us; we validate the sender, key
// the port by sender.tab.id, and post a `bind-offer` carrying the token.
// The app then ACKs back over the same port with `bind-ack` (which proves
// the page actually controls the tab the port came from).
//
// Defense in depth: `externally_connectable.matches` already filters at the
// protocol level, but every handler in this file ALSO checks
// sender.origin === APP_ORIGIN and sender.tab?.id is present before
// trusting any inbound message. If the matches entry is ever loosened by a
// future manifest edit, the in-handler check still keeps the registry
// clean.
//
// SW lifecycle (Chrome 116+): opening the port does NOT keep the SW alive —
// only messages sent over it do. The 10-second binding-rollback timer
// therefore lives in the SIDE PANEL JS (which stays alive as long as the
// panel is open), not here. We persist binding.status so an SW respawn
// mid-handshake picks up the same state.
//
// Publishable-only. The internal build's `externally_connectable` field is
// absent from its manifest, so even if this module were imported in the
// internal bundle the listener registration below would no-op (Chrome would
// never call into it).

import { bindingStore } from './storage.ts';
import type { ExtensionBinding } from './types.ts';
import { ts } from './logger.ts';

const tag = () => `[Pipeline Tracker Binding - ${ts()}]`;

export const APP_ORIGIN = 'https://app.cmcareersystems.com';
export const APP_PORT_NAME = 'pipeline-tracker-app';

// --- Sender validation (defense in depth alongside externally_connectable) ---

export function isValidAppSender(sender: chrome.runtime.MessageSender | undefined): boolean {
  if (!sender) return false;
  if (sender.origin !== APP_ORIGIN) return false;
  if (typeof sender.tab?.id !== 'number') return false;
  return true;
}

// --- Port registry: tabId → Port ---
//
// Keyed by tab id so multiple app tabs each get an entry (Phase 8 will
// broadcast across all). If a tab opens a fresh port before the prior one
// fully tore down, the new one replaces — Chrome's runtime port semantics
// already disconnect the old, so we deliberately overwrite rather than
// dedupe.

interface AppPortEntry {
  readonly port: chrome.runtime.Port;
  readonly tabId: number;
}

const appPorts = new Map<number, AppPortEntry>();

export function getAppPorts(): readonly AppPortEntry[] {
  return Array.from(appPorts.values());
}

export function getAppPortCount(): number {
  return appPorts.size;
}

/** Test-only — drop the registry between cases so port state doesn't leak. */
export function _clearAppPortsForTests(): void {
  appPorts.clear();
}

// --- Token generation ---

/**
 * UUIDv4 binding token. Falls back to a crypto-based string if randomUUID is
 * unavailable so a vintage runtime can still complete a handshake; the
 * production target (Chrome 116+) always has randomUUID.
 */
export function generateBindingToken(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // Synthesize from getRandomValues — guaranteed available even when
  // randomUUID isn't (e.g. older test runtimes). 16 random bytes formatted
  // as a UUIDv4 string.
  if (c && typeof c.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  throw new Error('No crypto source available for binding token generation');
}

// --- Wire types over the port ---

export interface BindOfferMessage {
  type: 'bind-offer';
  bindingToken: string;
}

export interface BindAckMessage {
  type: 'bind-ack';
  bindingToken: string;
}

export type AppPortInbound = BindAckMessage;

function isBindAck(msg: unknown): msg is BindAckMessage {
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as Record<string, unknown>;
  return m.type === 'bind-ack' && typeof m.bindingToken === 'string';
}

// --- Connection handling ---

/**
 * Wire a port from a verified app tab into the registry. Rejects (and
 * disconnects) any port whose sender fails validation. Returns true if the
 * port was accepted, false if it was rejected.
 */
export function acceptAppPort(port: chrome.runtime.Port): boolean {
  if (port.name !== APP_PORT_NAME) {
    console.warn(tag(), `rejecting port with unexpected name=${port.name}`);
    try {
      port.disconnect();
    } catch (err) {
      console.warn(tag(), 'disconnect of rejected port threw:', err);
    }
    return false;
  }
  if (!isValidAppSender(port.sender)) {
    console.warn(
      tag(),
      `rejecting port — sender failed validation, origin=${port.sender?.origin ?? 'undefined'}`,
    );
    try {
      port.disconnect();
    } catch (err) {
      console.warn(tag(), 'disconnect of rejected port threw:', err);
    }
    return false;
  }
  const tabId = port.sender!.tab!.id!;
  // If a prior port is still registered for this tab id, disconnect it
  // explicitly before overwriting. Chrome does NOT auto-dedupe ports by
  // tabId — the prior port stays alive until its own onDisconnect fires
  // (which can race the new connect), and broadcastBindOffer would only
  // reach the new entry while the orphan lingers in memory. Explicit
  // disconnect closes the stale handle and lets the prior port's
  // onDisconnect listener run with cur.port === oldPort, so its own
  // cleanup runs.
  const prior = appPorts.get(tabId);
  if (prior) {
    try {
      prior.port.disconnect();
    } catch (err) {
      console.warn(tag(), `failed to disconnect prior port for tabId=${tabId}:`, err);
    }
  }
  appPorts.set(tabId, { port, tabId });
  console.log(tag(), `port accepted, tabId=${tabId}, total=${appPorts.size}`);

  port.onDisconnect.addListener(() => {
    const cur = appPorts.get(tabId);
    if (cur && cur.port === port) {
      appPorts.delete(tabId);
      console.log(tag(), `port disconnected, tabId=${tabId}, total=${appPorts.size}`);
    }
  });

  port.onMessage.addListener((msg: unknown) => {
    void handleInbound(port, msg);
  });

  return true;
}

async function handleInbound(port: chrome.runtime.Port, msg: unknown): Promise<void> {
  if (isBindAck(msg)) {
    // Re-validate origin on each message — the port was accepted under one
    // sender snapshot, but a future Chrome change could in principle re-use
    // a port across renderer transitions. Cheap to check.
    if (!isValidAppSender(port.sender)) {
      console.warn(tag(), 'bind-ack arrived on a port that no longer passes sender validation');
      return;
    }
    try {
      await confirmBinding(msg.bindingToken);
    } catch (err) {
      // confirmBinding awaits bindingStore.set; storage failure (quota,
      // IO) would otherwise become an unhandled rejection in the SW
      // because the onMessage callback is `void handleInbound(...)`. Log
      // explicitly so the failure is traceable to the bind-ack path;
      // the side-panel's 10-s rollback timer will eventually clear the
      // pending binding so the user can retry.
      console.error(tag(), 'confirmBinding threw during bind-ack handling:', err);
    }
    return;
  }
  console.warn(tag(), 'unknown inbound port message:', msg);
}

/**
 * Flip the persisted binding to `confirmed` if the supplied token matches
 * the pending binding. Returns the new binding (or null when the ack didn't
 * match). Idempotent — re-acking an already-confirmed binding with the same
 * token is a no-op.
 */
export async function confirmBinding(bindingToken: string): Promise<ExtensionBinding | null> {
  const cur = await bindingStore.get();
  if (!cur) {
    console.warn(tag(), 'bind-ack received but no pending binding present');
    return null;
  }
  if (cur.token !== bindingToken) {
    console.warn(tag(), 'bind-ack token mismatch — refusing to confirm');
    return null;
  }
  if (cur.status === 'confirmed') return cur;
  const next: ExtensionBinding = { ...cur, status: 'confirmed' };
  await bindingStore.set(next);
  console.log(tag(), `binding confirmed, bound_at=${cur.bound_at}`);
  return next;
}

// --- Outbound: bind-offer broadcast ---
//
// Phase 7 sends to the FIRST connected app port (one-tab path). Phase 8
// generalizes to all ports with first-ack-wins semantics. Both phases land
// the same persisted token; the difference is just fan-out.

export interface BindOfferResult {
  /** Number of ports the offer was successfully posted to. */
  delivered: number;
  /** Number of ports the registry held but postMessage threw on (likely closed-mid-broadcast). */
  failed: number;
}

export function broadcastBindOffer(bindingToken: string): BindOfferResult {
  const offer: BindOfferMessage = { type: 'bind-offer', bindingToken };
  let delivered = 0;
  let failed = 0;
  for (const entry of appPorts.values()) {
    try {
      entry.port.postMessage(offer);
      delivered++;
    } catch (err) {
      failed++;
      console.warn(tag(), `bind-offer post to tab ${entry.tabId} failed:`, err);
      // The port is effectively dead — drop it from the registry so we
      // don't keep trying.
      appPorts.delete(entry.tabId);
    }
  }
  console.log(tag(), `bind-offer broadcast: delivered=${delivered}, failed=${failed}`);
  return { delivered, failed };
}

// --- Public binding lifecycle helpers (used by background.ts) ---

/**
 * Begin a binding handshake: write a fresh pending binding into storage,
 * then post bind-offer to every connected app port. Returns the persisted
 * binding + the offer result so the caller (background.ts → side panel) can
 * surface "Open CareerSystems first" if `delivered === 0`.
 *
 * This does NOT start the 10-second rollback timer — that lives in the side
 * panel (D-rev-12 SW-lifecycle note).
 */
export async function beginBinding(): Promise<{
  binding: ExtensionBinding;
  offer: BindOfferResult;
}> {
  const token = generateBindingToken();
  const binding: ExtensionBinding = {
    token,
    bound_at: new Date().toISOString(),
    status: 'pending',
  };
  await bindingStore.set(binding);
  const offer = broadcastBindOffer(token);
  return { binding, offer };
}

/**
 * Clear any persisted binding (Disconnect button + 10-s rollback failure).
 * Returns true if state was actually cleared.
 */
export async function clearBinding(): Promise<boolean> {
  const cur = await bindingStore.get();
  if (!cur) return false;
  await bindingStore.clear();
  console.log(tag(), `binding cleared, prior_status=${cur.status}`);
  return true;
}
