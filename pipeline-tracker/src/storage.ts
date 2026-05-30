// Typed facade over chrome.storage.local. Spec 012 Phase 1.
//
// Rules (D-rev-11):
//   (a) Quota-exceeded on set throws StorageQuotaExceededError; callers on
//       capture paths convert that to a HistoryEntry { status: 'error',
//       code: 'STORAGE_QUOTA' }.
//   (b) Every get validates the value against a shape predicate; on mismatch
//       the key resets to its default and the bad shape is warned about.
//   (c) ensureInitialized() runs once per SW spin-up to fill missing keys with
//       defaults — idempotent across spin-ups.
//
// CI guard #2 (package.json `guard:no-raw-storage-local`) forbids
// chrome.storage.local.{get,set} outside this file.

import {
  HISTORY_CAP,
  STORAGE_KEYS,
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

function isQuotaError(err: unknown): boolean {
  if (err instanceof Error && /quota/i.test(err.message)) return true;
  const lastError = chrome.runtime?.lastError;
  return !!lastError && /quota/i.test(lastError.message ?? '');
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

// === Validators (D-rev-11b) ===

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

function isHistoryArray(v: unknown): v is HistoryEntry[] {
  if (!Array.isArray(v)) return false;
  return v.every(
    (e) =>
      e !== null &&
      typeof e === 'object' &&
      typeof (e as HistoryEntry).id === 'string' &&
      typeof (e as HistoryEntry).status === 'string',
  );
}

function isOutboxArray(v: unknown): v is OutboxEntry[] {
  if (!Array.isArray(v)) return false;
  return v.every(
    (e) =>
      e !== null &&
      typeof e === 'object' &&
      typeof (e as OutboxEntry).history_id === 'string' &&
      typeof (e as OutboxEntry).enqueued_at === 'string',
  );
}

const SEVERITY_SET = new Set<Severity>(['ok', 'partial', 'error', 'pending']);
function isSeverity(v: unknown): v is Severity {
  return typeof v === 'string' && SEVERITY_SET.has(v as Severity);
}

// `Severity | null` — null means "no badge state yet".
function isSeverityOrNull(v: unknown): v is Severity | null {
  return v === null || isSeverity(v);
}

function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

// === Generic helper: get-with-validation-and-reset ===

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
    await rawSet({ [key]: cloneDefault(defaultValue) });
    return cloneDefault(defaultValue);
  }
  return raw;
}

function cloneDefault<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return [...v] as unknown as T;
  return { ...(v as Record<string, unknown>) } as T;
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
    return getValidated<OutboxEntry[]>(STORAGE_KEYS.OUTBOX, isOutboxArray, []);
  },
  async set(o: OutboxEntry[]): Promise<void> {
    await rawSet({ [STORAGE_KEYS.OUTBOX]: o });
  },
};

export const historyStore = {
  async get(): Promise<HistoryEntry[]> {
    return getValidated<HistoryEntry[]>(STORAGE_KEYS.HISTORY, isHistoryArray, []);
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
    // Reset on shape mismatch — defense in depth (D-rev-11b).
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
    if (Object.keys(fixups).length > 0) await rawSet(fixups);
    return result;
  },
  /** Set any subset of the badge state in a single chrome.storage.local.set call. */
  async setPartial(patch: Partial<BadgeState>): Promise<void> {
    const items: Record<string, unknown> = {};
    if (patch.unreadCount !== undefined) items[STORAGE_KEYS.UNREAD_COUNT] = patch.unreadCount;
    if (patch.highestSeverity !== undefined)
      items[STORAGE_KEYS.HIGHEST_SEVERITY] = patch.highestSeverity;
    if (patch.lastStatus !== undefined) items[STORAGE_KEYS.LAST_STATUS] = patch.lastStatus;
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
};

// === Quota → history error row (D-rev-11a) ===

/**
 * Append a HistoryEntry signaling that a chrome.storage.local write failed
 * due to quota. Callers on the capture path invoke this after they catch
 * StorageQuotaExceededError. Best-effort — if the history write itself
 * fails (e.g. quota again), we log and move on rather than throwing.
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
    await historyStore.prepend(entry);
  } catch (err) {
    // We're already in the quota path. Logging is the only safe action.
    console.error(tag(), 'failed to record STORAGE_QUOTA history row:', err);
  }
}
