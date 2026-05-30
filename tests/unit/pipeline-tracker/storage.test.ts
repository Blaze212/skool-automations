import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_SETTINGS,
  StorageQuotaExceededError,
  _resetInitLatchForTests,
  badgeStore,
  deliveryStore,
  ensureInitialized,
  historyStore,
  lastSyncedAtStore,
  outboxStore,
  recordStorageQuotaError,
  settingsStore,
} from '../../../pipeline-tracker/src/storage.ts';
import {
  STORAGE_KEYS,
  type HistoryEntry,
  type OutboxEntry,
  type Settings,
} from '../../../pipeline-tracker/src/types.ts';

interface Store {
  [key: string]: unknown;
}

/**
 * Replace the global chrome.storage.local.{get,set} mocks with a stateful
 * in-memory store. `set` accepts an optional `onSet` hook used to inject
 * quota-exceeded errors. Returns the store so tests can poke at it directly.
 */
function installStatefulStorage(onSet?: (items: Store) => void): { local: Store } {
  const local: Store = {};

  (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockImplementation(
    async (keys?: string | string[]) => {
      if (keys === undefined || keys === null) return { ...local };
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Store = {};
      for (const k of list) {
        if (k in local) out[k] = local[k];
      }
      return out;
    },
  );
  (chrome.storage.local.set as ReturnType<typeof vi.fn>).mockImplementation(
    async (entries: Store) => {
      if (onSet) onSet(entries);
      Object.assign(local, entries);
    },
  );

  return { local };
}

describe('pipeline-tracker storage facade', () => {
  let stores: ReturnType<typeof installStatefulStorage>;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetInitLatchForTests();
    stores = installStatefulStorage();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ----- ensureInitialized (D-rev-11c) -----

  describe('ensureInitialized', () => {
    it('fills missing SETTINGS + LAST_SYNCED_AT keys with defaults on first call', async () => {
      await ensureInitialized();
      expect(stores.local[STORAGE_KEYS.SETTINGS]).toEqual(DEFAULT_SETTINGS);
      expect(stores.local[STORAGE_KEYS.LAST_SYNCED_AT]).toBeNull();
    });

    it('is idempotent within a single SW spin-up — repeat calls do not overwrite', async () => {
      // Pre-populate as if a previous spin-up had already initialized.
      stores.local[STORAGE_KEYS.SETTINGS] = {
        ...DEFAULT_SETTINGS,
        capture_message_bodies: true,
      };
      stores.local[STORAGE_KEYS.LAST_SYNCED_AT] = '2026-05-30T00:00:00Z';

      await ensureInitialized();
      await ensureInitialized();
      await ensureInitialized();

      // The user's prior settings + last_synced_at are preserved.
      expect((stores.local[STORAGE_KEYS.SETTINGS] as Settings).capture_message_bodies).toBe(true);
      expect(stores.local[STORAGE_KEYS.LAST_SYNCED_AT]).toBe('2026-05-30T00:00:00Z');

      // chrome.storage.local.set was not called at all because nothing was missing.
      expect(chrome.storage.local.set).not.toHaveBeenCalled();
    });

    it('is idempotent across SW spin-ups — second spin-up sees existing keys and does not rewrite', async () => {
      await ensureInitialized();
      const setCallsAfterFirst = (chrome.storage.local.set as ReturnType<typeof vi.fn>).mock.calls
        .length;

      // Simulate a fresh SW spin-up by resetting the in-process latch.
      _resetInitLatchForTests();
      await ensureInitialized();

      const setCallsAfterSecond = (chrome.storage.local.set as ReturnType<typeof vi.fn>).mock.calls
        .length;
      // The first call wrote both defaults. The second should be a no-op
      // because both keys are already present.
      expect(setCallsAfterSecond).toBe(setCallsAfterFirst);
    });
  });

  // ----- settings get/set round-trip -----

  describe('settingsStore', () => {
    it('round-trips a Settings value', async () => {
      const next: Settings = {
        ai_fallback_enabled: true,
        ai_model_downloaded: false,
        capture_message_bodies: true,
        first_run_completed: true,
      };
      await settingsStore.set(next);
      expect(await settingsStore.get()).toEqual(next);
    });

    it('returns defaults when the key is missing', async () => {
      const result = await settingsStore.get();
      expect(result).toEqual(DEFAULT_SETTINGS);
    });

    it('shape-mismatch resets to default + warns (D-rev-11b)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // Garbage shape — missing required boolean fields.
      stores.local[STORAGE_KEYS.SETTINGS] = { ai_fallback_enabled: 'yes please' };

      const result = await settingsStore.get();
      expect(result).toEqual(DEFAULT_SETTINGS);
      expect(stores.local[STORAGE_KEYS.SETTINGS]).toEqual(DEFAULT_SETTINGS);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('update() merges patch into existing settings', async () => {
      await settingsStore.set({ ...DEFAULT_SETTINGS });
      const next = await settingsStore.update({ first_run_completed: true });
      expect(next.first_run_completed).toBe(true);
      expect(next.capture_message_bodies).toBe(false);
      expect((stores.local[STORAGE_KEYS.SETTINGS] as Settings).first_run_completed).toBe(true);
    });
  });

  // ----- lastSyncedAt get/set round-trip -----

  describe('lastSyncedAtStore', () => {
    it('round-trips a string value and null', async () => {
      await lastSyncedAtStore.set('2026-05-30T00:00:00Z');
      expect(await lastSyncedAtStore.get()).toBe('2026-05-30T00:00:00Z');

      await lastSyncedAtStore.set(null);
      expect(await lastSyncedAtStore.get()).toBeNull();
    });

    it('returns null when the key is missing', async () => {
      expect(await lastSyncedAtStore.get()).toBeNull();
    });

    it('shape-mismatch resets to null + warns (D-rev-11b)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      stores.local[STORAGE_KEYS.LAST_SYNCED_AT] = 42; // not a string, not null

      const result = await lastSyncedAtStore.get();
      expect(result).toBeNull();
      expect(stores.local[STORAGE_KEYS.LAST_SYNCED_AT]).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  // ----- outbox + history shape-validation -----

  describe('outboxStore + historyStore shape validation', () => {
    it('outbox shape-mismatch resets to [] + warns', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      stores.local[STORAGE_KEYS.OUTBOX] = [{ wrong: 'shape' }];
      expect(await outboxStore.get()).toEqual([]);
      expect(stores.local[STORAGE_KEYS.OUTBOX]).toEqual([]);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('history shape-mismatch resets to [] + warns', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      stores.local[STORAGE_KEYS.HISTORY] = 'not an array';
      expect(await historyStore.get()).toEqual([]);
      expect(stores.local[STORAGE_KEYS.HISTORY]).toEqual([]);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('outbox round-trips OutboxEntry[]', async () => {
      const entries: OutboxEntry[] = [
        {
          history_id: 'h1',
          enqueued_at: '2026-05-30T00:00:00Z',
          attempts: 0,
          event: {
            api_key: '',
            event_type: 'connection_request',
            date: '2026-05-30',
            name: 'X',
            title: '',
            linkedin_url: '',
            page_url: '',
            message_text: '',
          },
        },
      ];
      await outboxStore.set(entries);
      expect(await outboxStore.get()).toEqual(entries);
    });
  });

  // ----- badgeStore + deliveryStore -----

  describe('badgeStore', () => {
    it('returns defaults when nothing is stored', async () => {
      const snap = await badgeStore.get();
      expect(snap).toEqual({ unreadCount: 0, highestSeverity: 'ok', lastStatus: null });
    });

    it('setPartial only writes the keys provided', async () => {
      await badgeStore.setPartial({ unreadCount: 5 });
      expect(stores.local[STORAGE_KEYS.UNREAD_COUNT]).toBe(5);
      expect(STORAGE_KEYS.HIGHEST_SEVERITY in stores.local).toBe(false);
    });

    it('resets unread_count on shape mismatch + warns', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      stores.local[STORAGE_KEYS.UNREAD_COUNT] = 'not a number';
      const snap = await badgeStore.get();
      expect(snap.unreadCount).toBe(0);
      expect(stores.local[STORAGE_KEYS.UNREAD_COUNT]).toBe(0);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe('deliveryStore', () => {
    it('round-trips lastLoggedAt and lastError', async () => {
      await deliveryStore.setLastLoggedAt('2026-05-30T00:00:00Z');
      await deliveryStore.setLastError(null);
      expect(await deliveryStore.getLastLoggedAt()).toBe('2026-05-30T00:00:00Z');
      expect(await deliveryStore.getLastError()).toBeNull();
    });
  });

  // ----- Quota-exceeded path (D-rev-11a) -----

  describe('quota handling', () => {
    function installQuotaThrowingStorage(): { local: Store } {
      return installStatefulStorage((items) => {
        // Throw quota error UNLESS the only key being written is HISTORY —
        // we let the STORAGE_QUOTA history row land so the test can assert it.
        const keys = Object.keys(items);
        const onlyHistory = keys.length === 1 && keys[0] === STORAGE_KEYS.HISTORY;
        if (!onlyHistory) {
          throw new Error('QuotaExceededError: chrome.storage.local quota exceeded');
        }
      });
    }

    it('safeSet throws StorageQuotaExceededError on quota failure', async () => {
      stores = installQuotaThrowingStorage();
      await expect(outboxStore.set([])).rejects.toBeInstanceOf(StorageQuotaExceededError);
    });

    it('non-quota errors are re-thrown as-is (not wrapped)', async () => {
      stores = installStatefulStorage(() => {
        throw new Error('disk on fire');
      });
      await expect(outboxStore.set([])).rejects.toThrow('disk on fire');
      await expect(outboxStore.set([])).rejects.not.toBeInstanceOf(StorageQuotaExceededError);
    });

    it('recordStorageQuotaError prepends a STORAGE_QUOTA history row', async () => {
      stores = installQuotaThrowingStorage();
      await recordStorageQuotaError({
        id: 'h-quota-1',
        pageUrl: 'https://www.linkedin.com/in/jane/',
        name: 'Jane Doe',
        eventType: 'connection_request',
      });

      const history = stores.local[STORAGE_KEYS.HISTORY] as HistoryEntry[];
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        id: 'h-quota-1',
        status: 'error',
        code: 'STORAGE_QUOTA',
        name: 'Jane Doe',
        event_type: 'connection_request',
      });
    });

    it('recordStorageQuotaError swallows secondary quota failure (best-effort)', async () => {
      // Storage rejects EVERY write — even the STORAGE_QUOTA history row itself.
      // recordStorageQuotaError must not throw; it logs and moves on.
      stores = installStatefulStorage(() => {
        throw new Error('QuotaExceededError: quota');
      });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(
        recordStorageQuotaError({
          id: 'h-quota-2',
          pageUrl: '',
          eventType: 'connection_request',
        }),
      ).resolves.toBeUndefined();
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });
  });
});
