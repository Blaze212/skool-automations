// Spec 012 Phase 7 — binding handshake module.
//
// Coverage:
//   1. Sender validation — origin + sender.tab.id required.
//   2. acceptAppPort wires a valid port, rejects + disconnects invalid ones
//      (wrong origin, missing tab, wrong port name).
//   3. broadcastBindOffer posts to every registered port + tolerates a
//      single port throwing without nuking the rest.
//   4. confirmBinding flips status to 'confirmed' iff the token matches
//      the persisted pending binding; idempotent re-ack is OK.
//   5. beginBinding persists a fresh pending binding then broadcasts.
//   6. clearBinding removes any persisted binding.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  APP_ORIGIN,
  APP_PORT_NAME,
  _clearAppPortsForTests,
  acceptAppPort,
  beginBinding,
  broadcastBindOffer,
  clearBinding,
  confirmBinding,
  generateBindingToken,
  getAppPortCount,
  isValidAppSender,
} from '../../../pipeline-tracker/src/binding.ts';
import { _resetInitLatchForTests, bindingStore } from '../../../pipeline-tracker/src/storage.ts';
import { STORAGE_KEYS, type ExtensionBinding } from '../../../pipeline-tracker/src/types.ts';

interface LocalStore {
  [key: string]: unknown;
}

function installStatefulStorage(): LocalStore {
  const local: LocalStore = {};
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

interface FakePort {
  name: string;
  sender?: chrome.runtime.MessageSender;
  postMessage: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onMessage: { addListener: ReturnType<typeof vi.fn>; _listeners: Array<(m: unknown) => void> };
  onDisconnect: { addListener: ReturnType<typeof vi.fn>; _listeners: Array<() => void> };
  _fireMessage: (msg: unknown) => void;
  _fireDisconnect: () => void;
}

function makePort(
  overrides: { name?: string; sender?: chrome.runtime.MessageSender } = {},
): FakePort {
  const msgListeners: Array<(m: unknown) => void> = [];
  const discListeners: Array<() => void> = [];
  const port: FakePort = {
    name: overrides.name ?? APP_PORT_NAME,
    sender: overrides.sender,
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: {
      addListener: vi.fn((fn: (m: unknown) => void) => msgListeners.push(fn)),
      _listeners: msgListeners,
    },
    onDisconnect: {
      addListener: vi.fn((fn: () => void) => discListeners.push(fn)),
      _listeners: discListeners,
    },
    _fireMessage(msg: unknown): void {
      for (const fn of msgListeners) fn(msg);
    },
    _fireDisconnect(): void {
      for (const fn of discListeners) fn();
    },
  };
  return port;
}

function appSender(tabId = 42): chrome.runtime.MessageSender {
  return {
    origin: APP_ORIGIN,
    tab: { id: tabId } as chrome.tabs.Tab,
  } as chrome.runtime.MessageSender;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetInitLatchForTests();
  _clearAppPortsForTests();
});

afterEach(() => {
  _clearAppPortsForTests();
});

describe('binding — sender validation', () => {
  it('rejects when origin is wrong', () => {
    const sender = {
      origin: 'https://evil.example.com',
      tab: { id: 1 },
    } as chrome.runtime.MessageSender;
    expect(isValidAppSender(sender)).toBe(false);
  });

  it('rejects when sender.tab.id is missing', () => {
    const sender = { origin: APP_ORIGIN } as chrome.runtime.MessageSender;
    expect(isValidAppSender(sender)).toBe(false);
  });

  it('accepts the app origin with a numeric tab id', () => {
    expect(isValidAppSender(appSender(7))).toBe(true);
  });

  it('treats missing sender as invalid', () => {
    expect(isValidAppSender(undefined)).toBe(false);
  });
});

describe('binding — acceptAppPort', () => {
  it('accepts a well-formed port from the app origin', () => {
    const port = makePort({ sender: appSender(42) });
    expect(acceptAppPort(port as unknown as chrome.runtime.Port)).toBe(true);
    expect(getAppPortCount()).toBe(1);
  });

  it('disconnects a port whose sender origin is wrong', () => {
    const port = makePort({
      sender: {
        origin: 'https://evil.example.com',
        tab: { id: 1 },
      } as chrome.runtime.MessageSender,
    });
    expect(acceptAppPort(port as unknown as chrome.runtime.Port)).toBe(false);
    expect(port.disconnect).toHaveBeenCalledTimes(1);
    expect(getAppPortCount()).toBe(0);
  });

  it('disconnects a port whose name is wrong (defense in depth)', () => {
    const port = makePort({ name: 'unexpected', sender: appSender(1) });
    expect(acceptAppPort(port as unknown as chrome.runtime.Port)).toBe(false);
    expect(port.disconnect).toHaveBeenCalledTimes(1);
    expect(getAppPortCount()).toBe(0);
  });

  it('drops the registry entry when the port fires onDisconnect', () => {
    const port = makePort({ sender: appSender(99) });
    acceptAppPort(port as unknown as chrome.runtime.Port);
    expect(getAppPortCount()).toBe(1);
    port._fireDisconnect();
    expect(getAppPortCount()).toBe(0);
  });
});

describe('binding — bind-ack inbound', () => {
  it('flips the persisted binding to confirmed when the token matches', async () => {
    installStatefulStorage();
    await bindingStore.set({ token: 'abc', bound_at: 't', status: 'pending' });

    const port = makePort({ sender: appSender(1) });
    acceptAppPort(port as unknown as chrome.runtime.Port);

    port._fireMessage({ type: 'bind-ack', bindingToken: 'abc' });
    // Wait for the async handler.
    await new Promise((r) => setTimeout(r, 0));

    const next = await bindingStore.get();
    expect(next?.status).toBe('confirmed');
  });

  it('ignores bind-ack with the wrong token', async () => {
    installStatefulStorage();
    await bindingStore.set({ token: 'abc', bound_at: 't', status: 'pending' });

    const port = makePort({ sender: appSender(1) });
    acceptAppPort(port as unknown as chrome.runtime.Port);

    port._fireMessage({ type: 'bind-ack', bindingToken: 'WRONG' });
    await new Promise((r) => setTimeout(r, 0));

    const next = await bindingStore.get();
    expect(next?.status).toBe('pending');
  });

  it('ignores unknown port message types without crashing', async () => {
    installStatefulStorage();
    const port = makePort({ sender: appSender(1) });
    acceptAppPort(port as unknown as chrome.runtime.Port);

    expect(() => port._fireMessage({ type: 'mystery' })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe('binding — confirmBinding', () => {
  it('is idempotent on re-ack', async () => {
    installStatefulStorage();
    const b: ExtensionBinding = { token: 'tok', bound_at: 't', status: 'confirmed' };
    await bindingStore.set(b);

    await expect(confirmBinding('tok')).resolves.toEqual(b);
    expect((await bindingStore.get())?.status).toBe('confirmed');
  });

  it('returns null when no binding is present', async () => {
    installStatefulStorage();
    await expect(confirmBinding('tok')).resolves.toBeNull();
  });
});

describe('binding — broadcastBindOffer', () => {
  it('posts to every registered port', () => {
    const p1 = makePort({ sender: appSender(1) });
    const p2 = makePort({ sender: appSender(2) });
    acceptAppPort(p1 as unknown as chrome.runtime.Port);
    acceptAppPort(p2 as unknown as chrome.runtime.Port);

    const result = broadcastBindOffer('hello');
    expect(result.delivered).toBe(2);
    expect(result.failed).toBe(0);
    expect(p1.postMessage).toHaveBeenCalledWith({ type: 'bind-offer', bindingToken: 'hello' });
    expect(p2.postMessage).toHaveBeenCalledWith({ type: 'bind-offer', bindingToken: 'hello' });
  });

  it('tolerates a single port that throws on postMessage and drops it from the registry', () => {
    const good = makePort({ sender: appSender(1) });
    const bad = makePort({ sender: appSender(2) });
    bad.postMessage.mockImplementation(() => {
      throw new Error('port closed');
    });
    acceptAppPort(good as unknown as chrome.runtime.Port);
    acceptAppPort(bad as unknown as chrome.runtime.Port);

    const result = broadcastBindOffer('hello');
    expect(result.delivered).toBe(1);
    expect(result.failed).toBe(1);
    expect(getAppPortCount()).toBe(1);
    expect(good.postMessage).toHaveBeenCalled();
  });

  it('returns delivered=0 when no ports are registered (Phase 8 "open the app first" case)', () => {
    const result = broadcastBindOffer('hello');
    expect(result).toEqual({ delivered: 0, failed: 0 });
  });
});

describe('binding — beginBinding + clearBinding', () => {
  it('beginBinding persists a fresh pending binding then broadcasts', async () => {
    installStatefulStorage();
    const port = makePort({ sender: appSender(1) });
    acceptAppPort(port as unknown as chrome.runtime.Port);

    const { binding, offer } = await beginBinding();
    expect(binding.status).toBe('pending');
    expect(binding.token).toBeTruthy();
    expect(offer.delivered).toBe(1);

    const persisted = await bindingStore.get();
    expect(persisted?.token).toBe(binding.token);
    expect(persisted?.status).toBe('pending');
    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'bind-offer',
      bindingToken: binding.token,
    });
  });

  it('beginBinding still persists a pending binding when no ports are connected', async () => {
    const local = installStatefulStorage();
    const { offer } = await beginBinding();
    expect(offer.delivered).toBe(0);
    // The persisted binding is still pending — caller (side panel) decides
    // to clear it after surfacing "Open CareerSystems first."
    expect((local[STORAGE_KEYS.BINDING] as ExtensionBinding).status).toBe('pending');
  });

  it('clearBinding removes the persisted binding', async () => {
    installStatefulStorage();
    await bindingStore.set({ token: 'x', bound_at: 't', status: 'confirmed' });
    expect(await clearBinding()).toBe(true);
    expect(await bindingStore.get()).toBeNull();
  });

  it('clearBinding returns false when nothing was persisted', async () => {
    installStatefulStorage();
    expect(await clearBinding()).toBe(false);
  });
});

describe('binding — Phase 8 multi-tab broadcast (first ack wins)', () => {
  it('beginBinding broadcasts the offer to every connected app tab', async () => {
    installStatefulStorage();
    const p1 = makePort({ sender: appSender(1) });
    const p2 = makePort({ sender: appSender(2) });
    const p3 = makePort({ sender: appSender(3) });
    acceptAppPort(p1 as unknown as chrome.runtime.Port);
    acceptAppPort(p2 as unknown as chrome.runtime.Port);
    acceptAppPort(p3 as unknown as chrome.runtime.Port);

    const { binding, offer } = await beginBinding();
    expect(offer.delivered).toBe(3);
    for (const p of [p1, p2, p3]) {
      expect(p.postMessage).toHaveBeenCalledWith({
        type: 'bind-offer',
        bindingToken: binding.token,
      });
    }
  });

  it('first ack wins; subsequent acks for the same token are idempotent no-ops', async () => {
    installStatefulStorage();
    const p1 = makePort({ sender: appSender(1) });
    const p2 = makePort({ sender: appSender(2) });
    acceptAppPort(p1 as unknown as chrome.runtime.Port);
    acceptAppPort(p2 as unknown as chrome.runtime.Port);

    const { binding } = await beginBinding();
    p1._fireMessage({ type: 'bind-ack', bindingToken: binding.token });
    await new Promise((r) => setTimeout(r, 0));

    const afterFirst = await bindingStore.get();
    expect(afterFirst?.status).toBe('confirmed');
    const boundAtAfterFirst = afterFirst?.bound_at;

    // Second ack from a different tab with the SAME token — idempotent.
    p2._fireMessage({ type: 'bind-ack', bindingToken: binding.token });
    await new Promise((r) => setTimeout(r, 0));

    const afterSecond = await bindingStore.get();
    expect(afterSecond?.status).toBe('confirmed');
    expect(afterSecond?.bound_at).toBe(boundAtAfterFirst);
    expect(afterSecond?.token).toBe(binding.token);
  });

  it('late ack from a tab racing a rebind with a NEW token is rejected', async () => {
    installStatefulStorage();
    const p1 = makePort({ sender: appSender(1) });
    const p2 = makePort({ sender: appSender(2) });
    acceptAppPort(p1 as unknown as chrome.runtime.Port);
    acceptAppPort(p2 as unknown as chrome.runtime.Port);

    const first = await beginBinding();
    const second = await beginBinding();
    expect(second.binding.token).not.toBe(first.binding.token);

    // p2 acks the OLD token after a rebind already overwrote.
    p2._fireMessage({ type: 'bind-ack', bindingToken: first.binding.token });
    await new Promise((r) => setTimeout(r, 0));

    const persisted = await bindingStore.get();
    expect(persisted?.status).toBe('pending');
    expect(persisted?.token).toBe(second.binding.token);

    // p1 acks the new token — confirms cleanly.
    p1._fireMessage({ type: 'bind-ack', bindingToken: second.binding.token });
    await new Promise((r) => setTimeout(r, 0));
    expect((await bindingStore.get())?.status).toBe('confirmed');
  });
});

describe('binding — generateBindingToken', () => {
  it('returns a non-empty string', () => {
    const t = generateBindingToken();
    expect(typeof t).toBe('string');
    expect(t.length).toBeGreaterThan(0);
  });

  it('returns a UUID-shaped value when randomUUID is available', () => {
    const t = generateBindingToken();
    // Loose check: 36 chars and 4 dashes.
    expect(t).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});
