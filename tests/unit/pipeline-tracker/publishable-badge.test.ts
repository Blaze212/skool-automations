// Spec 012 Phase 5 — publishable build badge logic + onInstalled setPanelBehavior.
//
// Coverage:
//   1. refreshPublishableBadge transitions:
//        - empty outbox + no error  → text cleared
//        - N unsynced + no error    → text = "N" in BADGE_COLOR_PENDING
//        - error highest severity   → ✕ in BADGE_COLOR_ERROR (overrides count)
//        - partial highest severity → ! in BADGE_COLOR_PARTIAL (overrides count)
//   2. handleMessage drain_outbox under publishable target refreshes the badge
//      but does NOT call the webhook drain path.
//   3. restoreBadgeOnStartup under publishable target paints the badge from
//      outbox length, not from lastStatus.
//   4. onInstalled callback under publishable target calls
//      chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: true}).
//   5. onInstalled callback under internal target does NOT call setPanelBehavior
//      (the manifest doesn't declare the sidePanel permission for that build).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _setBuildTargetForTests,
  handleMessage,
  refreshPublishableBadge,
  restoreBadgeOnStartup,
} from '../../../pipeline-tracker/src/background.ts';
// Capture the onInstalled listener that was registered as a module-load side
// effect of importing background.ts. Vitest defines BUILD_TARGET='internal' so
// the alarm gate fired internal-build; the setPanelBehavior gate is INSIDE the
// callback, evaluated at fire time — that's what _setBuildTargetForTests exists
// for.
const _onInstalledListenerCalls = [
  ...(chrome.runtime.onInstalled.addListener as ReturnType<typeof vi.fn>).mock.calls,
];
import { _resetInitLatchForTests } from '../../../pipeline-tracker/src/storage.ts';
import {
  BADGE_COLOR_ERROR,
  BADGE_COLOR_PARTIAL,
  BADGE_COLOR_PENDING,
  BADGE_TEXT_ERROR,
  BADGE_TEXT_PARTIAL,
  STORAGE_KEYS,
  type HistoryEntry,
  type OutboxEntry,
} from '../../../pipeline-tracker/src/types.ts';

interface LocalStore {
  [key: string]: unknown;
}

function installStatefulStorage(initial: LocalStore = {}): LocalStore {
  const local: LocalStore = { ...initial };
  const read = (keys: string | string[] | undefined): LocalStore => {
    if (keys === undefined) return { ...local };
    const list = Array.isArray(keys) ? keys : [keys];
    const out: LocalStore = {};
    for (const k of list) if (k in local) out[k] = local[k];
    return out;
  };
  (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockImplementation(
    async (keys?: string | string[]) => read(keys),
  );
  (chrome.storage.local.set as ReturnType<typeof vi.fn>).mockImplementation(
    async (entries: LocalStore) => {
      Object.assign(local, entries);
    },
  );
  (chrome.storage.local.remove as ReturnType<typeof vi.fn>).mockImplementation(
    async (keys: string | string[]) => {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) delete local[k];
    },
  );
  return local;
}

function outboxOf(n: number): OutboxEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    history_id: `h${i}`,
    enqueued_at: new Date(2026, 4, 30, 10, 0, 0, i).toISOString(),
    attempts: 0,
    event: {
      api_key: 'pk',
      event_type: 'connection_request' as const,
      date: '2026-05-30',
      name: `N${i}`,
      title: '',
      linkedin_url: '',
      page_url: '',
      message_text: '',
    },
  }));
}

function histErrorRow(): HistoryEntry {
  return {
    id: 'h-err',
    ts: '2026-05-30T10:00:00.000Z',
    status: 'error',
    event_type: 'connection_request',
    name: 'N',
    page_url: '',
    message: 'Storage full',
    warnings: [],
    code: 'STORAGE_QUOTA',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetInitLatchForTests();
  _setBuildTargetForTests('publishable');
});

afterEach(() => {
  _setBuildTargetForTests('internal');
});

describe('refreshPublishableBadge', () => {
  it('clears the text when outbox is empty and no error severity', async () => {
    installStatefulStorage();
    await refreshPublishableBadge();
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: '' });
  });

  it('renders the count in BADGE_COLOR_PENDING when there are unsynced events', async () => {
    installStatefulStorage({ [STORAGE_KEYS.OUTBOX]: outboxOf(7) });
    await refreshPublishableBadge();
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: '7' });
    expect(chrome.action.setBadgeBackgroundColor).toHaveBeenLastCalledWith({
      color: BADGE_COLOR_PENDING,
    });
  });

  it('overrides count with ✕ + red when highestSeverity is error (spec 007 precedence)', async () => {
    installStatefulStorage({
      [STORAGE_KEYS.OUTBOX]: outboxOf(3),
      [STORAGE_KEYS.HIGHEST_SEVERITY]: 'error',
      [STORAGE_KEYS.HISTORY]: [histErrorRow()],
    });
    await refreshPublishableBadge();
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: BADGE_TEXT_ERROR });
    expect(chrome.action.setBadgeBackgroundColor).toHaveBeenLastCalledWith({
      color: BADGE_COLOR_ERROR,
    });
  });

  it('overrides count with ! + amber when highestSeverity is partial', async () => {
    installStatefulStorage({
      [STORAGE_KEYS.OUTBOX]: outboxOf(3),
      [STORAGE_KEYS.HIGHEST_SEVERITY]: 'partial',
    });
    await refreshPublishableBadge();
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: BADGE_TEXT_PARTIAL });
    expect(chrome.action.setBadgeBackgroundColor).toHaveBeenLastCalledWith({
      color: BADGE_COLOR_PARTIAL,
    });
  });
});

describe('handleMessage drain_outbox under publishable target', () => {
  it('refreshes the badge but does not trigger any fetch (no webhook drain)', async () => {
    installStatefulStorage({ [STORAGE_KEYS.OUTBOX]: outboxOf(2) });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await handleMessage({ kind: 'drain_outbox' });

    expect(result).toEqual({ ok: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: '2' });
  });
});

describe('restoreBadgeOnStartup under publishable target', () => {
  it('paints the badge from outbox length, not from lastStatus', async () => {
    installStatefulStorage({
      [STORAGE_KEYS.OUTBOX]: outboxOf(4),
      // lastStatus is internal-build noise; publishable must ignore it for the
      // resting badge (severity override still wins via highestSeverity, but
      // lastStatus alone shouldn't paint anything for publishable).
      [STORAGE_KEYS.LAST_STATUS]: 'ok',
    });
    await restoreBadgeOnStartup();
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: '4' });
    expect(chrome.action.setBadgeBackgroundColor).toHaveBeenLastCalledWith({
      color: BADGE_COLOR_PENDING,
    });
  });
});

describe('chrome.runtime.onInstalled — setPanelBehavior gating', () => {
  it('calls chrome.sidePanel.setPanelBehavior under publishable target', async () => {
    installStatefulStorage();
    _setBuildTargetForTests('publishable');
    expect(_onInstalledListenerCalls.length).toBeGreaterThan(0);
    const listener = _onInstalledListenerCalls[0][0] as (
      details: chrome.runtime.InstalledDetails,
    ) => void;

    listener({ reason: 'install' } as chrome.runtime.InstalledDetails);
    // setPanelBehavior is called synchronously inside the listener after the
    // build-target gate; the .catch is best-effort. Microtask drain to settle
    // initThenDrain's chained promise.
    await Promise.resolve();
    await Promise.resolve();

    expect(chrome.sidePanel.setPanelBehavior).toHaveBeenCalledWith({
      openPanelOnActionClick: true,
    });
  });

  it('does NOT call setPanelBehavior under internal target (no sidePanel permission in that manifest)', async () => {
    installStatefulStorage();
    _setBuildTargetForTests('internal');
    const listener = _onInstalledListenerCalls[0][0] as (
      details: chrome.runtime.InstalledDetails,
    ) => void;

    listener({ reason: 'install' } as chrome.runtime.InstalledDetails);
    await Promise.resolve();

    expect(chrome.sidePanel.setPanelBehavior).not.toHaveBeenCalled();
  });
});
