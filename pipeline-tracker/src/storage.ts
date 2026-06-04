// Typed facade over chrome.storage.local. Spec 012 Phase 1.
//
// Rules (D-rev-11):
//   (a) Quota-exceeded on set throws StorageQuotaExceededError; callers on
//       capture paths convert that to a HistoryEntry { status: 'error',
//       code: 'STORAGE_QUOTA' } via recordStorageQuotaError, which also
//       bumps unread + highest severity (spec 007).
//   (b) Every get validates the value against a shape predicate; on mismatch
//       the key resets to its default (or — for the two array-keyed stores —
//       salvages individual valid entries) and the bad shape is warned about.
//   (c) ensureInitialized() runs once per SW spin-up to fill missing keys with
//       defaults. Idempotent — must be awaited at every entry point that may
//       read settings/last_synced_at (handleMessage, onAlarm, onStartup,
//       onInstalled, the module-load startup hook).
//
// Atomic multi-key writes: callers that need to mutate logically-coupled keys
// (history + badge, outbox + history, delivery success+clear-error, history +
// badge clear in the popup) MUST use the dedicated multi-key helpers exported
// at the bottom of this file. Two sequential .set() calls don't satisfy
// chrome.storage.local's per-call atomicity guarantee — a quota failure on the
// second call leaves the two keys diverged. The helpers below issue one
// rawSet().
//
// CI guard #2 (package.json `guard:no-raw-storage-local`) forbids
// chrome.storage.local.{get,set} outside this file.

import {
  HISTORY_CAP,
  STORAGE_KEYS,
  type ExtensionBinding,
  type HistoryEntry,
  type OutboxEntry,
  type Severity,
  type Settings,
} from './types.ts';
import { ts } from './logger.ts';

const tag = () => `[Pipeline Tracker Storage - ${ts()}]`;

// === Defaults ===

export const DEFAULT_SETTINGS: Settings = {
  ai_fallback_enabled: false,
  ai_model_downloaded: false,
  capture_message_bodies: false,
  first_run_completed: false,
};

// === Errors ===

export class StorageQuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageQuotaExceededError';
  }
}

/**
 * Thrown by recoveredHtmlStore.set when the HTML payload exceeds the 16 KB
 * cap. Spec 013 enforces the same cap at strip time; the facade enforces it
 * again at the persist boundary so a single misbehaving caller can't poison
 * chrome.storage.local with a massive value.
 */
export class RecoveredHtmlTooLargeError extends Error {
  readonly historyId: string;
  readonly bytes: number;
  constructor(historyId: string, bytes: number) {
    super(`recovered_html for ${historyId} is ${bytes} bytes, exceeds 16 KB cap`);
    this.name = 'RecoveredHtmlTooLargeError';
    this.historyId = historyId;
    this.bytes = bytes;
  }
}

/** Spec 012 D-rev-28 / D-AI-4 — 16 KB cap on recovered_html at persist boundary. */
export const RECOVERED_HTML_MAX_BYTES = 16 * 1024;

// The `recovered_html_` prefix is RESERVED — no other STORAGE_KEYS value may
// start with it, and recoveredHtmlStore guards against empty historyId so
// `recovered_html_` (no suffix) is never produced as a real key.
const RECOVERED_HTML_KEY_PREFIX = 'recovered_html_';

function recoveredHtmlKey(historyId: string): string {
  return `${RECOVERED_HTML_KEY_PREFIX}${historyId}`;
}

// Hoisted — TextEncoder is stateless and reused across set() calls. Spec 013's
// AI-fallback hot path can write recovered_html repeatedly; we don't want each
// call to allocate a fresh encoder.
const _utf8Encoder = new TextEncoder();

// Quota detection uses the error itself only. We deliberately do NOT consult
// `chrome.runtime.lastError` — that channel is meaningful only inside the
// callback-style API, and reading it here from a promise-API rejection risks
// misclassifying an unrelated stale lastError (e.g. a prior storage.sync write)
// as a local-storage quota event. The promise rejection's Error / DOMException
// is the authoritative signal.
function isQuotaError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'QuotaExceededError') return true; // DOMException form
  return /quota/i.test(err.message);
}

// === Raw IO (only place that touches chrome.storage.local in the codebase) ===

async function rawGet(keys: string | string[]): Promise<Record<string, unknown>> {
  return (await chrome.storage.local.get(keys)) as Record<string, unknown>;
}

async function rawSet(items: Record<string, unknown>): Promise<void> {
  try {
    await chrome.storage.local.set(items);
  } catch (err) {
    if (isQuotaError(err)) {
      throw new StorageQuotaExceededError(
        err instanceof Error ? err.message : 'chrome.storage.local quota exceeded',
      );
    }
    throw err;
  }
}

async function rawRemove(keys: string | string[]): Promise<void> {
  await chrome.storage.local.remove(keys);
}

// === Validators (D-rev-11b) ===

const SEVERITY_SET = new Set<Severity>(['ok', 'partial', 'error', 'pending']);
function isSeverity(v: unknown): v is Severity {
  return typeof v === 'string' && SEVERITY_SET.has(v as Severity);
}
function isSeverityOrNull(v: unknown): v is Severity | null {
  return v === null || isSeverity(v);
}
function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}
function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

const EVENT_TYPE_SET = new Set(['connection_request', 'accepted_connection', 'direct_message']);

function isSettings(v: unknown): v is Settings {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.ai_fallback_enabled === 'boolean' &&
    typeof s.ai_model_downloaded === 'boolean' &&
    typeof s.capture_message_bodies === 'boolean' &&
    typeof s.first_run_completed === 'boolean'
  );
}

// Per-entry predicates. The OUTBOX / HISTORY array stores use these to salvage
// individual valid entries rather than wiping the whole array on a single bad
// row — a corruption in entry[5] should not silently destroy entries 0–4 and
// 6–N that the user is still owed delivery for.
function isHistoryEntry(e: unknown): e is HistoryEntry {
  if (e === null || typeof e !== 'object') return false;
  const h = e as Record<string, unknown>;
  return (
    typeof h.id === 'string' &&
    typeof h.ts === 'string' &&
    isSeverity(h.status) &&
    typeof h.event_type === 'string' &&
    EVENT_TYPE_SET.has(h.event_type) &&
    typeof h.name === 'string' &&
    typeof h.page_url === 'string' &&
    typeof h.message === 'string' &&
    Array.isArray(h.warnings)
  );
}

function isOutboxEntry(e: unknown): e is OutboxEntry {
  if (e === null || typeof e !== 'object') return false;
  const o = e as Record<string, unknown>;
  return (
    typeof o.history_id === 'string' &&
    typeof o.enqueued_at === 'string' &&
    isNumber(o.attempts) &&
    o.event !== null &&
    typeof o.event === 'object'
  );
}

const BINDING_STATUS_SET = new Set<ExtensionBinding['status']>(['pending', 'confirmed']);
function isExtensionBinding(v: unknown): v is ExtensionBinding {
  if (!v || typeof v !== 'object') return false;
  const b = v as Record<string, unknown>;
  return (
    typeof b.token === 'string' &&
    b.token.length > 0 &&
    typeof b.bound_at === 'string' &&
    typeof b.status === 'string' &&
    BINDING_STATUS_SET.has(b.status as ExtensionBinding['status']) &&
    (b.account_email === undefined || typeof b.account_email === 'string')
  );
}

// === Generic helpers ===

function cloneDefault<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return [...v] as unknown as T;
  return { ...(v as Record<string, unknown>) } as T;
}

/**
 * Read a key, validate its shape, and on mismatch reset to the default and
 * return the default. The reset rawSet is best-effort: if it itself throws
 * (e.g. quota), we swallow and return the default anyway — callers that
 * invoke this from read paths (popup init, badge restoration) must never see
 * a thrown StorageQuotaExceededError from what they treat as a pure read.
 */
async function getValidated<T>(
  key: string,
  predicate: (v: unknown) => v is T,
  defaultValue: T,
): Promise<T> {
  const r = await rawGet(key);
  const raw = r[key];
  if (raw === undefined) return cloneDefault(defaultValue);
  if (!predicate(raw)) {
    console.warn(tag(), `${key} shape mismatch — resetting to default`);
    try {
      await rawSet({ [key]: cloneDefault(defaultValue) });
    } catch (err) {
      console.warn(tag(), `failed to reset ${key} to default (best-effort):`, err);
    }
    return cloneDefault(defaultValue);
  }
  return raw;
}

/**
 * Read a known-array key, salvage entries that pass the per-entry predicate,
 * and if any entries had to be filtered out, write the salvaged array back
 * (best-effort; quota failure on the salvage write is swallowed).
 */
async function getValidatedArray<T>(key: string, perEntry: (e: unknown) => e is T): Promise<T[]> {
  const r = await rawGet(key);
  const raw = r[key];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    console.warn(tag(), `${key} shape mismatch (not an array) — resetting to []`);
    try {
      await rawSet({ [key]: [] });
    } catch (err) {
      console.warn(tag(), `failed to reset ${key} (best-effort):`, err);
    }
    return [];
  }
  const salvaged = raw.filter(perEntry);
  if (salvaged.length !== raw.length) {
    console.warn(
      tag(),
      `${key} had ${raw.length - salvaged.length} invalid entr${raw.length - salvaged.length === 1 ? 'y' : 'ies'} — salvaging ${salvaged.length}/${raw.length}`,
    );
    try {
      await rawSet({ [key]: salvaged });
    } catch (err) {
      console.warn(tag(), `failed to write salvaged ${key} (best-effort):`, err);
    }
  }
  return salvaged;
}

// === Initialization (D-rev-11c) ===

let _initPromise: Promise<void> | null = null;

export function ensureInitialized(): Promise<void> {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    const all = await rawGet([STORAGE_KEYS.SETTINGS, STORAGE_KEYS.LAST_SYNCED_AT]);
    const missing: Record<string, unknown> = {};
    if (all[STORAGE_KEYS.SETTINGS] === undefined) {
      missing[STORAGE_KEYS.SETTINGS] = { ...DEFAULT_SETTINGS };
    }
    if (all[STORAGE_KEYS.LAST_SYNCED_AT] === undefined) {
      missing[STORAGE_KEYS.LAST_SYNCED_AT] = null;
    }
    if (Object.keys(missing).length > 0) {
      await rawSet(missing);
    }
  })().catch((err: unknown) => {
    // Reset so the next caller retries — don't latch a failed init permanently.
    _initPromise = null;
    throw err;
  });
  return _initPromise;
}

/** Test-only — drop the init latch so a fresh ensureInitialized() runs. */
export function _resetInitLatchForTests(): void {
  _initPromise = null;
}

// === Stores ===

export const settingsStore = {
  async get(): Promise<Settings> {
    return getValidated(STORAGE_KEYS.SETTINGS, isSettings, { ...DEFAULT_SETTINGS });
  },
  async set(s: Settings): Promise<void> {
    await rawSet({ [STORAGE_KEYS.SETTINGS]: s });
  },
  async update(patch: Partial<Settings>): Promise<Settings> {
    const cur = await settingsStore.get();
    const next = { ...cur, ...patch };
    await settingsStore.set(next);
    return next;
  },
};

/**
 * Spec 012 Phase 2 — D-rev-8 two-phase binding handshake. The token + status
 * live on a single key; clear() removes the key entirely rather than writing
 * null so storage stays minimal when the user is unbound.
 *
 * Phase 2 only exposes the API; Phase 7 wires the side-panel handshake to it.
 */
export const bindingStore = {
  async get(): Promise<ExtensionBinding | null> {
    const r = await rawGet(STORAGE_KEYS.BINDING);
    const raw = r[STORAGE_KEYS.BINDING];
    if (raw === undefined || raw === null) return null;
    if (!isExtensionBinding(raw)) {
      // Clearing an unrecognizable binding matches the spec D-rev-11b 'reset
      // to default' rule (default = unbound) AND is what the user perceives
      // anyway — an unusable binding is the same as no binding. But for an
      // auth-adjacent key, destroying state silently makes future schema
      // upgrades opaque to debug. Log the SHAPE (key names + types only;
      // never the token value) before clearing so version-mismatch incidents
      // leave a trail in the SW console.
      const shapeFingerprint =
        typeof raw === 'object' && raw !== null
          ? Object.fromEntries(
              Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, typeof v]),
            )
          : typeof raw;
      console.warn(
        tag(),
        `${STORAGE_KEYS.BINDING} shape mismatch — clearing. shape was:`,
        shapeFingerprint,
      );
      try {
        await rawRemove(STORAGE_KEYS.BINDING);
      } catch (err) {
        console.warn(tag(), `failed to clear ${STORAGE_KEYS.BINDING} (best-effort):`, err);
      }
      return null;
    }
    return raw;
  },
  /**
   * Persist a binding. Throws TypeError on invalid shape (caller-side bug —
   * e.g. status mistyped as 'confirm' instead of 'confirmed'). This is
   * intentionally a different class from StorageQuotaExceededError; the
   * facade convention is: storage-side failures throw Storage*, caller-side
   * bugs throw TypeError. Catchers in Phase 7's handshake should handle both.
   */
  async set(b: ExtensionBinding): Promise<void> {
    if (!isExtensionBinding(b)) {
      throw new TypeError('bindingStore.set called with invalid ExtensionBinding shape');
    }
    await rawSet({ [STORAGE_KEYS.BINDING]: b });
  },
  async clear(): Promise<void> {
    await rawRemove(STORAGE_KEYS.BINDING);
  },
};

export const lastSyncedAtStore = {
  async get(): Promise<string | null> {
    return getValidated(STORAGE_KEYS.LAST_SYNCED_AT, isStringOrNull, null);
  },
  async set(v: string | null): Promise<void> {
    await rawSet({ [STORAGE_KEYS.LAST_SYNCED_AT]: v });
  },
};

export const outboxStore = {
  async get(): Promise<OutboxEntry[]> {
    return getValidatedArray(STORAGE_KEYS.OUTBOX, isOutboxEntry);
  },
  async set(o: OutboxEntry[]): Promise<void> {
    await rawSet({ [STORAGE_KEYS.OUTBOX]: o });
  },
};

export const historyStore = {
  async get(): Promise<HistoryEntry[]> {
    return getValidatedArray(STORAGE_KEYS.HISTORY, isHistoryEntry);
  },
  async set(h: HistoryEntry[]): Promise<void> {
    await rawSet({ [STORAGE_KEYS.HISTORY]: h });
  },
  /** Prepend an entry, capped at HISTORY_CAP. Returns the new array. */
  async prepend(entry: HistoryEntry): Promise<HistoryEntry[]> {
    const prev = await historyStore.get();
    const next = [entry, ...prev].slice(0, HISTORY_CAP);
    await historyStore.set(next);
    return next;
  },
};

/**
 * Spec 012 Phase 2 / D-rev-28 — per-id recovered_html storage.
 *
 * Each history_id gets its own key (`recovered_html_<historyId>`) so the hot
 * OutboxEntry payload stays ~2 KB and we never load all recovered HTML at
 * once. Spec 013 populates these keys during AI fallback; this spec's
 * sync-pull (Phase 9) and CSV export (Phase 11) read them per-row.
 *
 * 16 KB cap is enforced at set() — defense in depth alongside spec 013's
 * strip-time cap. UTF-8 byte length, not character count.
 */
function utf8ByteLength(s: string): number {
  return _utf8Encoder.encode(s).length;
}

function assertHistoryId(historyId: string): void {
  // Empty historyId would collapse to the bare `recovered_html_` key (a
  // collision domain shared across all empty-id callers). Defensive — every
  // real caller has a UUID/randomUUID-derived id.
  if (typeof historyId !== 'string' || historyId.length === 0) {
    throw new TypeError('recoveredHtmlStore: historyId must be a non-empty string');
  }
}

export const recoveredHtmlStore = {
  async set(historyId: string, html: string): Promise<void> {
    assertHistoryId(historyId);
    const bytes = utf8ByteLength(html);
    if (bytes > RECOVERED_HTML_MAX_BYTES) {
      throw new RecoveredHtmlTooLargeError(historyId, bytes);
    }
    await rawSet({ [recoveredHtmlKey(historyId)]: html });
  },
  async get(historyId: string): Promise<string | null> {
    assertHistoryId(historyId);
    const key = recoveredHtmlKey(historyId);
    const r = await rawGet(key);
    const raw = r[key];
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== 'string') {
      console.warn(tag(), `${key} shape mismatch — removing`);
      try {
        await rawRemove(key);
      } catch (err) {
        console.warn(tag(), `failed to remove ${key} (best-effort):`, err);
      }
      return null;
    }
    return raw;
  },
  async remove(historyId: string): Promise<void> {
    assertHistoryId(historyId);
    await rawRemove(recoveredHtmlKey(historyId));
  },
  /**
   * Batch-remove recovered_html for multiple historyIds. Callers (Phase 11
   * CSV export's HISTORY_CAP rollover, spec 013's settings-toggle wipe) use
   * this to clean up orphan recovered_html_<id> bytes when their referencing
   * HistoryEntry/OutboxEntry rolls off.
   */
  async removeMany(historyIds: string[]): Promise<void> {
    if (historyIds.length === 0) return;
    const keys = historyIds.map((id) => {
      assertHistoryId(id);
      return recoveredHtmlKey(id);
    });
    await rawRemove(keys);
  },
  /**
   * Spec 012 Phase 8 — wipes EVERY recovered_html_* key, regardless of
   * whether a matching OutboxEntry currently exists. Used by the SW's
   * `wipe_unsynced` handler during the rebind 3-choice modal's
   * delete-outbox path so orphan recovered_html bytes (from prior partial
   * syncs / SW teardowns mid-write) don't leak to a different
   * CareerSystems user signing in on the same Chrome profile.
   *
   * Enumerates by querying chrome.storage.local for all keys (which is
   * what rawGet() with no arg does) and filtering by the
   * RECOVERED_HTML_KEY_PREFIX. The prefix is reserved (storage.ts comment
   * on STORAGE_KEYS pins this), so no other key shape can collide.
   */
  async removeAll(): Promise<number> {
    // chrome.storage.local.get(null) returns the entire store as one map.
    // We then filter by the reserved RECOVERED_HTML_KEY_PREFIX. Inside the
    // facade so guard #2 (no raw chrome.storage.local outside this file)
    // stays clean.
    const everything = (await chrome.storage.local.get(null)) as Record<string, unknown>;
    const keys = Object.keys(everything).filter((k) => k.startsWith(RECOVERED_HTML_KEY_PREFIX));
    if (keys.length === 0) return 0;
    await rawRemove(keys);
    return keys.length;
  },
};

// Badge state (unread + highest severity + last status) is read together as a
// snapshot by background.ts; expose it the same way so writers can keep
// multi-key set atomicity.
export interface BadgeState {
  unreadCount: number;
  highestSeverity: Severity;
  lastStatus: Severity | null;
}

const DEFAULT_BADGE_STATE: BadgeState = {
  unreadCount: 0,
  highestSeverity: 'ok',
  lastStatus: null,
};

function buildBadgePatchItems(patch: Partial<BadgeState>): Record<string, unknown> {
  const items: Record<string, unknown> = {};
  if (patch.unreadCount !== undefined) items[STORAGE_KEYS.UNREAD_COUNT] = patch.unreadCount;
  if (patch.highestSeverity !== undefined) {
    items[STORAGE_KEYS.HIGHEST_SEVERITY] = patch.highestSeverity;
  }
  if (patch.lastStatus !== undefined) items[STORAGE_KEYS.LAST_STATUS] = patch.lastStatus;
  return items;
}

export const badgeStore = {
  async get(): Promise<BadgeState> {
    const r = await rawGet([
      STORAGE_KEYS.UNREAD_COUNT,
      STORAGE_KEYS.HIGHEST_SEVERITY,
      STORAGE_KEYS.LAST_STATUS,
    ]);
    const unread = r[STORAGE_KEYS.UNREAD_COUNT];
    const highest = r[STORAGE_KEYS.HIGHEST_SEVERITY];
    const last = r[STORAGE_KEYS.LAST_STATUS];
    const result: BadgeState = {
      unreadCount: isNumber(unread) ? unread : DEFAULT_BADGE_STATE.unreadCount,
      highestSeverity: isSeverity(highest) ? highest : DEFAULT_BADGE_STATE.highestSeverity,
      lastStatus: isSeverityOrNull(last) ? last : DEFAULT_BADGE_STATE.lastStatus,
    };
    // Reset on shape mismatch — defense in depth (D-rev-11b). Best-effort:
    // a quota failure on the salvage write must not turn this read into a throw.
    const fixups: Record<string, unknown> = {};
    if (unread !== undefined && !isNumber(unread)) {
      console.warn(tag(), `${STORAGE_KEYS.UNREAD_COUNT} shape mismatch — resetting`);
      fixups[STORAGE_KEYS.UNREAD_COUNT] = DEFAULT_BADGE_STATE.unreadCount;
    }
    if (highest !== undefined && !isSeverity(highest)) {
      console.warn(tag(), `${STORAGE_KEYS.HIGHEST_SEVERITY} shape mismatch — resetting`);
      fixups[STORAGE_KEYS.HIGHEST_SEVERITY] = DEFAULT_BADGE_STATE.highestSeverity;
    }
    if (last !== undefined && !isSeverityOrNull(last)) {
      console.warn(tag(), `${STORAGE_KEYS.LAST_STATUS} shape mismatch — resetting`);
      fixups[STORAGE_KEYS.LAST_STATUS] = DEFAULT_BADGE_STATE.lastStatus;
    }
    if (Object.keys(fixups).length > 0) {
      try {
        await rawSet(fixups);
      } catch (err) {
        console.warn(tag(), 'failed to reset badge fixups (best-effort):', err);
      }
    }
    return result;
  },
  /** Set any subset of the badge state in a single chrome.storage.local.set call. */
  async setPartial(patch: Partial<BadgeState>): Promise<void> {
    const items = buildBadgePatchItems(patch);
    if (Object.keys(items).length === 0) return;
    await rawSet(items);
  },
};

export const deliveryStore = {
  async getLastLoggedAt(): Promise<string | null> {
    return getValidated(STORAGE_KEYS.LAST_LOGGED_AT, isStringOrNull, null);
  },
  async setLastLoggedAt(v: string | null): Promise<void> {
    await rawSet({ [STORAGE_KEYS.LAST_LOGGED_AT]: v });
  },
  async getLastError(): Promise<string | null> {
    return getValidated(STORAGE_KEYS.LAST_ERROR, isStringOrNull, null);
  },
  async setLastError(v: string | null): Promise<void> {
    await rawSet({ [STORAGE_KEYS.LAST_ERROR]: v });
  },
  /** Atomic — used on POST success so a stale lastError doesn't linger alongside a fresh lastLoggedAt. */
  async setLastLoggedAndClearError(loggedAt: string): Promise<void> {
    await rawSet({
      [STORAGE_KEYS.LAST_LOGGED_AT]: loggedAt,
      [STORAGE_KEYS.LAST_ERROR]: null,
    });
  },
};

// === Atomic multi-key helpers ===
//
// These exist because chrome.storage.local guarantees per-set atomicity but
// callers historically wrote multiple logically-coupled keys in one set().
// Splitting that set into two awaits introduces a window where a quota
// failure on the second write diverges the two keys. Reuse these helpers
// instead of two sequential .set() calls when state is coupled.

/** outbox + history in one set (content.ts enqueue path). */
export async function setOutboxAndHistory(
  outbox: OutboxEntry[],
  history: HistoryEntry[],
): Promise<void> {
  await rawSet({
    [STORAGE_KEYS.OUTBOX]: outbox,
    [STORAGE_KEYS.HISTORY]: history,
  });
}

/** history + (any subset of) badge state in one set (background recordResolved). */
export async function setHistoryAndBadge(
  history: HistoryEntry[],
  badgePatch: Partial<BadgeState>,
): Promise<void> {
  const items: Record<string, unknown> = {
    [STORAGE_KEYS.HISTORY]: history,
    ...buildBadgePatchItems(badgePatch),
  };
  await rawSet(items);
}

/**
 * Outbox + history + a recovered_html_<historyId> row in one set. Used by
 * spec 013's AI-fallback enqueue path so a SW teardown between the recovery
 * write and the outbox write can't leave orphan recovered_html bytes that
 * nothing references.
 *
 * Phase 2 exposes this even though no caller exists yet — pairing the helper
 * with the recoveredHtmlStore API in the same phase keeps the atomicity
 * contract close to the data and prevents spec 013 from accidentally writing
 * them in two awaits.
 */
export async function setOutboxHistoryAndRecoveredHtml(
  outbox: OutboxEntry[],
  history: HistoryEntry[],
  historyId: string,
  html: string,
): Promise<void> {
  if (typeof historyId !== 'string' || historyId.length === 0) {
    throw new TypeError('setOutboxHistoryAndRecoveredHtml: historyId must be a non-empty string');
  }
  const bytes = utf8ByteLength(html);
  if (bytes > RECOVERED_HTML_MAX_BYTES) {
    throw new RecoveredHtmlTooLargeError(historyId, bytes);
  }
  await rawSet({
    [STORAGE_KEYS.OUTBOX]: outbox,
    [STORAGE_KEYS.HISTORY]: history,
    [recoveredHtmlKey(historyId)]: html,
  });
}

// === Quota → history error row (D-rev-11a) ===

/**
 * Append a HistoryEntry signaling that a chrome.storage.local write failed
 * due to quota AND atomically bump unread + highest severity so the badge
 * surfaces the failure (spec 007 — error rows raise the bubble). Callers on
 * the capture path invoke this after they catch StorageQuotaExceededError.
 *
 * Best-effort — if storage is still over quota we can't write the warning row;
 * we log and return rather than re-throwing into the capture path.
 */
export async function recordStorageQuotaError(params: {
  id: string;
  pageUrl: string;
  name?: string;
  eventType: HistoryEntry['event_type'];
}): Promise<void> {
  const entry: HistoryEntry = {
    id: params.id,
    ts: new Date().toISOString(),
    status: 'error',
    event_type: params.eventType,
    name: params.name ?? '',
    page_url: params.pageUrl,
    message: 'Storage full — clear history to keep capturing.',
    warnings: [],
    code: 'STORAGE_QUOTA',
  };
  try {
    const prev = await historyStore.get();
    const badge = await badgeStore.get();
    const next = [entry, ...prev].slice(0, HISTORY_CAP);
    // 'error' is the highest severity — always wins the rank comparison.
    await setHistoryAndBadge(next, {
      unreadCount: badge.unreadCount + 1,
      highestSeverity: 'error',
      lastStatus: 'error',
    });
  } catch (err) {
    // We're already in the quota path. Logging is the only safe action.
    console.error(tag(), 'failed to record STORAGE_QUOTA history row:', err);
  }
}

/**
 * Phase 10 — atomic sync-ack batch. Removes each matched outbox entry by
 * history_id, flips its history row to status:'ok', and removes the per-id
 * recovered_html key. Outbox + history + last_synced_at land in a single
 * rawSet call (D-rev-29). recovered_html keys are removed in a separate
 * rawRemove call — crash-safe last step; orphan keys are cleaned up by
 * wipe_unsynced on next rebind. Unknown ids are silently skipped.
 */
export async function resolveOutboxBatch(syncedIds: string[]): Promise<{ ackedCount: number }> {
  if (syncedIds.length === 0) return { ackedCount: 0 };

  const idSet = new Set(syncedIds);
  const [outbox, history] = await Promise.all([outboxStore.get(), historyStore.get()]);

  const newOutbox = outbox.filter((entry) => !idSet.has(entry.history_id));
  const ackedCount = outbox.length - newOutbox.length;

  if (ackedCount === 0) return { ackedCount: 0 };

  const now = new Date().toISOString();
  const newHistory = history.map((entry) => {
    if (!idSet.has(entry.id)) return entry;
    return { ...entry, status: 'ok' as Severity, message: 'Synced via app', ts: now };
  });

  await rawSet({
    [STORAGE_KEYS.OUTBOX]: newOutbox,
    [STORAGE_KEYS.HISTORY]: newHistory,
    [STORAGE_KEYS.LAST_SYNCED_AT]: now,
  });

  const ackedIds = outbox
    .filter((entry) => idSet.has(entry.history_id))
    .map((entry) => entry.history_id);
  await recoveredHtmlStore.removeMany(ackedIds);

  return { ackedCount };
}

/** Fields the side-panel review UI lets the user correct on a flagged row. */
export interface OutboxReviewEdits {
  name: string;
  title: string;
  linkedin_url: string;
  message_text: string;
}

/**
 * Spec 015 B2 — apply a user's review edits to a flagged outbox entry.
 *
 * Overwrites the event's name/title/linkedin_url with the corrected values and
 * marks the entry `user_reviewed` so sync-pull will release it. Because the user
 * fixed the row by hand, the per-id recovered_html (the on-device AI carry) is
 * dropped — no server-side reconciliation is needed for a human-approved row.
 * Returns whether a matching entry was found. Unknown id is a no-op.
 */
export async function reviewOutboxEntry(
  historyId: string,
  edits: OutboxReviewEdits,
): Promise<{ updated: boolean }> {
  const outbox = await outboxStore.get();
  let updated = false;
  const next = outbox.map((entry) => {
    if (entry.history_id !== historyId) return entry;
    updated = true;
    return {
      ...entry,
      event: {
        ...entry.event,
        name: edits.name,
        title: edits.title,
        linkedin_url: edits.linkedin_url,
        message_text: edits.message_text,
      },
      user_reviewed: true,
    };
  });
  if (!updated) return { updated: false };

  await outboxStore.set(next);
  // User-corrected → server AI fallback is unnecessary; drop the carried HTML.
  await recoveredHtmlStore.remove(historyId);
  return { updated: true };
}

/**
 * Spec 015 B2 — approve flagged outbox entries as-is (no edits). Sets
 * `user_reviewed` on each matching entry so sync-pull releases it on the next
 * pull; recovered_html is left intact so the server can still reconcile.
 * Returns how many entries were flipped.
 */
export async function markOutboxReviewed(historyIds: string[]): Promise<{ reviewedCount: number }> {
  if (historyIds.length === 0) return { reviewedCount: 0 };
  const idSet = new Set(historyIds);
  const outbox = await outboxStore.get();
  let reviewedCount = 0;
  const next = outbox.map((entry) => {
    if (!idSet.has(entry.history_id) || entry.user_reviewed) return entry;
    reviewedCount += 1;
    return { ...entry, user_reviewed: true };
  });
  if (reviewedCount === 0) return { reviewedCount: 0 };
  await outboxStore.set(next);
  return { reviewedCount };
}
