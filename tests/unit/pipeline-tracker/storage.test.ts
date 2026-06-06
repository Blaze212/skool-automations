import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_SETTINGS,
  RECOVERED_HTML_MAX_BYTES,
  RecoveredHtmlTooLargeError,
  StorageQuotaExceededError,
  _resetInitLatchForTests,
  badgeStore,
  bindingStore,
  deliveryStore,
  ensureInitialized,
  historyStore,
  lastSyncedAtStore,
  markOutboxReviewed,
  outboxStore,
  recordStorageQuotaError,
  recoveredHtmlStore,
  reviewOutboxEntry,
  setHistoryAndBadge,
  setOutboxAndHistory,
  settingsStore,
} from '../../../pipeline-tracker/src/storage.ts';
import {
  STORAGE_KEYS,
  type ExtensionBinding,
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
  (chrome.storage.local.remove as ReturnType<typeof vi.fn>).mockImplementation(
    async (keys: string | string[]) => {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) delete local[k];
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
    it('outbox shape-mismatch resets to [] + warns (all entries invalid)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      stores.local[STORAGE_KEYS.OUTBOX] = [{ wrong: 'shape' }];
      expect(await outboxStore.get()).toEqual([]);
      expect(stores.local[STORAGE_KEYS.OUTBOX]).toEqual([]);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('outbox salvages valid entries when only some are corrupt', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const goodEntry: OutboxEntry = {
        history_id: 'good',
        enqueued_at: '2026-05-30T00:00:00Z',
        attempts: 0,
        event: {
          api_key: '',
          event_type: 'connection_request',
          date: '2026-05-30',
          name: 'X',
          title: '',
          profile_url: '',
          page_url: '',
          message_text: '',
        },
      };
      stores.local[STORAGE_KEYS.OUTBOX] = [
        goodEntry,
        { history_id: 'bad', enqueued_at: 'not-a-string', attempts: 0 }, // missing event
        { wrong: 'shape' },
        goodEntry,
      ];
      const salvaged = await outboxStore.get();
      expect(salvaged).toHaveLength(2);
      // Storage was rewritten with only the valid entries — one bad row no
      // longer wipes the entire outbox.
      expect((stores.local[STORAGE_KEYS.OUTBOX] as OutboxEntry[]).length).toBe(2);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('history salvages valid entries when only some are corrupt', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const goodEntry: HistoryEntry = {
        id: 'g',
        ts: '2026-05-30T00:00:00Z',
        status: 'ok',
        event_type: 'connection_request',
        name: 'X',
        page_url: '',
        message: 'Logged',
        warnings: [],
      };
      stores.local[STORAGE_KEYS.HISTORY] = [
        goodEntry,
        { id: 'bad', status: 'unknown-severity' }, // invalid status
        goodEntry,
      ];
      const salvaged = await historyStore.get();
      expect(salvaged).toHaveLength(2);
      expect((stores.local[STORAGE_KEYS.HISTORY] as HistoryEntry[]).length).toBe(2);
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
            profile_url: '',
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
        // Throw quota error UNLESS the write is the recordStorageQuotaError
        // atomic set — history + badge bump. The capture-path enqueue (outbox +
        // history) still throws so the test models a near-quota condition that
        // permits a tiny bookkeeping write but not the larger payload write.
        const keys = new Set(Object.keys(items));
        const isQuotaErrorWrite =
          keys.has(STORAGE_KEYS.HISTORY) &&
          !keys.has(STORAGE_KEYS.OUTBOX) &&
          // history + at most {unread_count, highest_severity, last_status}
          keys.size <= 4;
        if (!isQuotaErrorWrite) {
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

    it('recordStorageQuotaError prepends a STORAGE_QUOTA history row + bumps the badge', async () => {
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

      // Badge bump — spec 007 says error rows raise the badge. Pre-fix the
      // STORAGE_QUOTA path only wrote the history row, leaving the badge silent.
      expect(stores.local[STORAGE_KEYS.UNREAD_COUNT]).toBe(1);
      expect(stores.local[STORAGE_KEYS.HIGHEST_SEVERITY]).toBe('error');
      expect(stores.local[STORAGE_KEYS.LAST_STATUS]).toBe('error');
    });

    it('setHistoryAndBadge issues a single chrome.storage.local.set with all keys', async () => {
      const setSpy = chrome.storage.local.set as ReturnType<typeof vi.fn>;
      await setHistoryAndBadge([], { unreadCount: 0, highestSeverity: 'ok', lastStatus: null });
      // The original two-call pattern would have been 2 set() invocations.
      // The new atomic helper is exactly 1.
      expect(setSpy).toHaveBeenCalledTimes(1);
      const items = setSpy.mock.calls[0][0] as Record<string, unknown>;
      expect(items[STORAGE_KEYS.HISTORY]).toEqual([]);
      expect(items[STORAGE_KEYS.UNREAD_COUNT]).toBe(0);
      expect(items[STORAGE_KEYS.HIGHEST_SEVERITY]).toBe('ok');
      expect(items[STORAGE_KEYS.LAST_STATUS]).toBeNull();
    });

    it('setOutboxAndHistory issues a single chrome.storage.local.set with both keys', async () => {
      const setSpy = chrome.storage.local.set as ReturnType<typeof vi.fn>;
      await setOutboxAndHistory([], []);
      expect(setSpy).toHaveBeenCalledTimes(1);
      const items = setSpy.mock.calls[0][0] as Record<string, unknown>;
      expect(items[STORAGE_KEYS.OUTBOX]).toEqual([]);
      expect(items[STORAGE_KEYS.HISTORY]).toEqual([]);
    });

    it('shape-mismatch read swallows quota errors from the reset write (read never throws)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      stores = installStatefulStorage(() => {
        throw new Error('QuotaExceededError: quota');
      });
      // Seed an invalid value so the validator triggers a reset-write.
      stores.local[STORAGE_KEYS.SETTINGS] = { wrong: 'shape' };
      // Pre-fix: the reset rawSet would throw and the read would crash the
      // popup. Post-fix: we swallow + log, return the default.
      const result = await settingsStore.get();
      expect(result).toEqual(DEFAULT_SETTINGS);
      warnSpy.mockRestore();
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

  // ----- Phase 2: bindingStore (D-rev-8) -----

  describe('bindingStore', () => {
    const validBinding: ExtensionBinding = {
      token: 'b-1234',
      bound_at: '2026-05-30T00:00:00Z',
      status: 'pending',
    };

    it('get() returns null when no binding is stored', async () => {
      expect(await bindingStore.get()).toBeNull();
    });

    it('round-trips an ExtensionBinding', async () => {
      await bindingStore.set(validBinding);
      expect(await bindingStore.get()).toEqual(validBinding);
      expect(stores.local[STORAGE_KEYS.BINDING]).toEqual(validBinding);
    });

    it('clear() removes the BINDING key entirely (not just nulled out)', async () => {
      await bindingStore.set(validBinding);
      await bindingStore.clear();
      expect(STORAGE_KEYS.BINDING in stores.local).toBe(false);
      expect(await bindingStore.get()).toBeNull();
    });

    it('set() rejects an invalid binding shape (defensive)', async () => {
      await expect(
        bindingStore.set({
          token: '',
          bound_at: '2026-05-30T00:00:00Z',
          status: 'pending',
        }),
      ).rejects.toBeInstanceOf(TypeError);
      // Bad write was prevented; storage stays empty.
      expect(STORAGE_KEYS.BINDING in stores.local).toBe(false);
    });

    it('get() clears the key + returns null on shape mismatch (D-rev-11b)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      stores.local[STORAGE_KEYS.BINDING] = { token: 'x', status: 'WAT' }; // bad status
      const result = await bindingStore.get();
      expect(result).toBeNull();
      expect(STORAGE_KEYS.BINDING in stores.local).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("accepts both 'pending' and 'confirmed' status values", async () => {
      await bindingStore.set({ ...validBinding, status: 'pending' });
      expect((await bindingStore.get())?.status).toBe('pending');
      await bindingStore.set({ ...validBinding, status: 'confirmed' });
      expect((await bindingStore.get())?.status).toBe('confirmed');
    });
  });

  // ----- Phase 2: recoveredHtmlStore (D-rev-28) -----

  describe('recoveredHtmlStore', () => {
    it('set() writes under the per-id key `recovered_html_<historyId>`', async () => {
      await recoveredHtmlStore.set('hist-1', '<div>hello</div>');
      expect(stores.local['recovered_html_hist-1']).toBe('<div>hello</div>');
      // The hot OUTBOX/HISTORY keys are untouched — recovered_html lives only
      // under its per-id key so the hot payload stays small.
      expect(STORAGE_KEYS.OUTBOX in stores.local).toBe(false);
      expect(STORAGE_KEYS.HISTORY in stores.local).toBe(false);
    });

    it('get() round-trips a stored value', async () => {
      await recoveredHtmlStore.set('hist-1', '<div>hello</div>');
      expect(await recoveredHtmlStore.get('hist-1')).toBe('<div>hello</div>');
    });

    it('get() returns null cleanly when the key is missing', async () => {
      expect(await recoveredHtmlStore.get('nope')).toBeNull();
    });

    it('remove() deletes the per-id key', async () => {
      await recoveredHtmlStore.set('hist-1', '<div>hello</div>');
      await recoveredHtmlStore.remove('hist-1');
      expect('recovered_html_hist-1' in stores.local).toBe(false);
      expect(await recoveredHtmlStore.get('hist-1')).toBeNull();
    });

    it('remove() on a missing id is a no-op (not an error)', async () => {
      await expect(recoveredHtmlStore.remove('never-existed')).resolves.toBeUndefined();
    });

    it('multiple per-id values are independent', async () => {
      await recoveredHtmlStore.set('a', '<a>');
      await recoveredHtmlStore.set('b', '<b>');
      await recoveredHtmlStore.remove('a');
      expect(await recoveredHtmlStore.get('a')).toBeNull();
      expect(await recoveredHtmlStore.get('b')).toBe('<b>');
    });

    it('rejects HTML over the 16 KB UTF-8 cap', async () => {
      const oneByteOver = 'a'.repeat(RECOVERED_HTML_MAX_BYTES + 1);
      await expect(recoveredHtmlStore.set('hist-1', oneByteOver)).rejects.toBeInstanceOf(
        RecoveredHtmlTooLargeError,
      );
      // Nothing landed in storage.
      expect('recovered_html_hist-1' in stores.local).toBe(false);
    });

    it('accepts HTML exactly at the 16 KB cap', async () => {
      const exact = 'a'.repeat(RECOVERED_HTML_MAX_BYTES);
      await expect(recoveredHtmlStore.set('hist-1', exact)).resolves.toBeUndefined();
      expect(stores.local['recovered_html_hist-1']).toBe(exact);
    });

    it('cap is measured in UTF-8 bytes, not character count', async () => {
      // Each '€' encodes to 3 UTF-8 bytes.
      const charsThatFit = Math.floor(RECOVERED_HTML_MAX_BYTES / 3);
      const charsThatOverflow = charsThatFit + 1;
      await expect(recoveredHtmlStore.set('a', '€'.repeat(charsThatFit))).resolves.toBeUndefined();
      await expect(
        recoveredHtmlStore.set('b', '€'.repeat(charsThatOverflow)),
      ).rejects.toBeInstanceOf(RecoveredHtmlTooLargeError);
    });

    it('quota error on set() bubbles as StorageQuotaExceededError (not TooLargeError)', async () => {
      // Scoped install so the throwing storage stays inside this test —
      // subsequent it()s in this describe get the normal stateful mock from
      // beforeEach.
      installStatefulStorage(() => {
        throw new Error('QuotaExceededError: storage');
      });
      await expect(recoveredHtmlStore.set('hist-1', '<small>')).rejects.toBeInstanceOf(
        StorageQuotaExceededError,
      );
    });

    it('set/get/remove reject empty historyId (collision-domain defense)', async () => {
      await expect(recoveredHtmlStore.set('', '<x>')).rejects.toBeInstanceOf(TypeError);
      await expect(recoveredHtmlStore.get('')).rejects.toBeInstanceOf(TypeError);
      await expect(recoveredHtmlStore.remove('')).rejects.toBeInstanceOf(TypeError);
    });

    it('removeMany clears multiple per-id keys in one chrome.storage.local.remove call', async () => {
      await recoveredHtmlStore.set('a', '<a>');
      await recoveredHtmlStore.set('b', '<b>');
      await recoveredHtmlStore.set('c', '<c>');

      const removeSpy = chrome.storage.local.remove as ReturnType<typeof vi.fn>;
      removeSpy.mockClear();

      await recoveredHtmlStore.removeMany(['a', 'c']);

      expect(removeSpy).toHaveBeenCalledTimes(1);
      // Single batch call with both keys, not one call per id.
      const passedKeys = removeSpy.mock.calls[0][0] as string[];
      expect(passedKeys).toEqual(['recovered_html_a', 'recovered_html_c']);

      expect('recovered_html_a' in stores.local).toBe(false);
      expect('recovered_html_c' in stores.local).toBe(false);
      expect(stores.local['recovered_html_b']).toBe('<b>'); // untouched
    });

    it('removeMany is a no-op on empty input (no storage call)', async () => {
      const removeSpy = chrome.storage.local.remove as ReturnType<typeof vi.fn>;
      removeSpy.mockClear();
      await recoveredHtmlStore.removeMany([]);
      expect(removeSpy).not.toHaveBeenCalled();
    });

    it('get() returns null + clears the key on shape mismatch', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      stores.local['recovered_html_hist-1'] = 42; // not a string
      expect(await recoveredHtmlStore.get('hist-1')).toBeNull();
      expect('recovered_html_hist-1' in stores.local).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  // ----- Phase 2: atomic helper for spec 013 -----

  describe('setOutboxHistoryAndRecoveredHtml', () => {
    it('writes outbox + history + recovered_html_<id> in a single set() call', async () => {
      const setSpy = chrome.storage.local.set as ReturnType<typeof vi.fn>;
      setSpy.mockClear();

      const { setOutboxHistoryAndRecoveredHtml } =
        await import('../../../pipeline-tracker/src/storage.ts');
      await setOutboxHistoryAndRecoveredHtml([], [], 'hist-1', '<recovered>');

      expect(setSpy).toHaveBeenCalledTimes(1);
      const items = setSpy.mock.calls[0][0] as Record<string, unknown>;
      expect(items[STORAGE_KEYS.OUTBOX]).toEqual([]);
      expect(items[STORAGE_KEYS.HISTORY]).toEqual([]);
      expect(items['recovered_html_hist-1']).toBe('<recovered>');
    });

    it('rejects empty historyId before touching storage', async () => {
      const setSpy = chrome.storage.local.set as ReturnType<typeof vi.fn>;
      setSpy.mockClear();

      const { setOutboxHistoryAndRecoveredHtml } =
        await import('../../../pipeline-tracker/src/storage.ts');
      await expect(setOutboxHistoryAndRecoveredHtml([], [], '', '<x>')).rejects.toBeInstanceOf(
        TypeError,
      );
      expect(setSpy).not.toHaveBeenCalled();
    });

    it('rejects oversize HTML before touching storage', async () => {
      const setSpy = chrome.storage.local.set as ReturnType<typeof vi.fn>;
      setSpy.mockClear();

      const { setOutboxHistoryAndRecoveredHtml } =
        await import('../../../pipeline-tracker/src/storage.ts');
      const tooBig = 'a'.repeat(RECOVERED_HTML_MAX_BYTES + 1);
      await expect(
        setOutboxHistoryAndRecoveredHtml([], [], 'hist-1', tooBig),
      ).rejects.toBeInstanceOf(RecoveredHtmlTooLargeError);
      expect(setSpy).not.toHaveBeenCalled();
    });
  });

  // ----- Phase 2 review fixups: bindingStore shape-mismatch logs structure -----

  describe('bindingStore shape-mismatch debuggability', () => {
    it('logs the bad value’s key/type shape (but not the token value) before clearing', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      stores.local[STORAGE_KEYS.BINDING] = {
        token: 'SECRET-TOKEN-VALUE',
        bound_at: '2026-05-30T00:00:00Z',
        status: 'pending',
        extra_field_from_future_phase: 42,
      };
      // Missing required validation — say status was changed to enum that
      // doesn't include 'pending'. Force shape mismatch:
      stores.local[STORAGE_KEYS.BINDING] = {
        token: 'SECRET-TOKEN-VALUE',
        weird_field: 'x',
      };
      await bindingStore.get();
      // The warn call should include the SHAPE fingerprint (key -> typeof),
      // never the token value itself.
      const seenArgs = warnSpy.mock.calls.flat().map(String).join(' | ');
      expect(seenArgs).toContain('shape mismatch');
      expect(seenArgs).not.toContain('SECRET-TOKEN-VALUE');
      warnSpy.mockRestore();
    });
  });

  // ----- Spec 015 B2: review mutators -----
  describe('reviewOutboxEntry', () => {
    function flaggedEntry(id: string): OutboxEntry {
      return {
        history_id: id,
        enqueued_at: '2026-06-01T00:00:00Z',
        attempts: 0,
        scrape_confidence: 'low',
        needs_review: true,
        event: {
          api_key: 'pk',
          event_type: 'connection_request',
          date: '2026-06-01',
          name: 'Connect',
          title: '',
          profile_url: 'https://www.linkedin.com/feed/',
          page_url: 'https://www.linkedin.com/feed/',
          message_text: '',
          scrape_confidence: 'low',
        },
      };
    }

    it('applies edits, marks user_reviewed, and drops recovered_html', async () => {
      stores.local[STORAGE_KEYS.OUTBOX] = [flaggedEntry('h-1'), flaggedEntry('h-2')];
      stores.local['recovered_html_h-1'] = '<div>carry</div>';

      const res = await reviewOutboxEntry('h-1', {
        name: 'Jane Smith',
        title: 'Staff Engineer',
        profile_url: 'https://www.linkedin.com/in/jane-smith',
        message_text: 'Hi Jane — great to connect!',
      });

      expect(res).toEqual({ updated: true });
      const outbox = stores.local[STORAGE_KEYS.OUTBOX] as OutboxEntry[];
      const edited = outbox.find((e) => e.history_id === 'h-1')!;
      expect(edited.event.name).toBe('Jane Smith');
      expect(edited.event.title).toBe('Staff Engineer');
      expect(edited.event.profile_url).toBe('https://www.linkedin.com/in/jane-smith');
      expect(edited.event.message_text).toBe('Hi Jane — great to connect!');
      expect(edited.user_reviewed).toBe(true);
      // recovered_html for the edited row is gone; the other row is untouched.
      expect('recovered_html_h-1' in stores.local).toBe(false);
      expect(outbox.find((e) => e.history_id === 'h-2')!.user_reviewed).toBeUndefined();
    });

    it('is a no-op for an unknown id (no write)', async () => {
      stores.local[STORAGE_KEYS.OUTBOX] = [flaggedEntry('h-1')];
      (chrome.storage.local.set as ReturnType<typeof vi.fn>).mockClear();

      const res = await reviewOutboxEntry('nope', {
        name: 'x',
        title: '',
        profile_url: '',
        message_text: '',
      });

      expect(res).toEqual({ updated: false });
      expect(chrome.storage.local.set).not.toHaveBeenCalled();
    });
  });

  describe('markOutboxReviewed', () => {
    function flaggedEntry(id: string, user_reviewed = false): OutboxEntry {
      return {
        history_id: id,
        enqueued_at: '2026-06-01T00:00:00Z',
        attempts: 0,
        scrape_confidence: 'low',
        needs_review: true,
        user_reviewed,
        event: {
          api_key: 'pk',
          event_type: 'connection_request',
          date: '2026-06-01',
          name: 'Connect',
          title: '',
          profile_url: '',
          page_url: '',
          message_text: '',
        },
      };
    }

    it('flips user_reviewed on the matching entries and counts them', async () => {
      stores.local[STORAGE_KEYS.OUTBOX] = [flaggedEntry('a'), flaggedEntry('b'), flaggedEntry('c')];

      const res = await markOutboxReviewed(['a', 'c']);

      expect(res).toEqual({ reviewedCount: 2 });
      const outbox = stores.local[STORAGE_KEYS.OUTBOX] as OutboxEntry[];
      expect(outbox.find((e) => e.history_id === 'a')!.user_reviewed).toBe(true);
      expect(outbox.find((e) => e.history_id === 'b')!.user_reviewed).toBe(false);
      expect(outbox.find((e) => e.history_id === 'c')!.user_reviewed).toBe(true);
    });

    it('does not re-count already-reviewed entries and skips the write when nothing changes', async () => {
      stores.local[STORAGE_KEYS.OUTBOX] = [flaggedEntry('a', true)];
      (chrome.storage.local.set as ReturnType<typeof vi.fn>).mockClear();

      const res = await markOutboxReviewed(['a']);

      expect(res).toEqual({ reviewedCount: 0 });
      expect(chrome.storage.local.set).not.toHaveBeenCalled();
    });

    it('empty id list is a no-op', async () => {
      const res = await markOutboxReviewed([]);
      expect(res).toEqual({ reviewedCount: 0 });
    });
  });
});
