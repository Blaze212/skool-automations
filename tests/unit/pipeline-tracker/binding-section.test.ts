// Spec 012 Phase 7 — binding section (publishable side panel).
//
// Coverage:
//   1. Unbound state renders Connect button; click → startBinding called.
//   2. Pending state renders countdown + auto-rolls back after 10s.
//   3. Confirmed state renders Disconnect button; click → clearBinding called.
//   4. delivered=0 from startBinding surfaces "Open CareerSystems first" and
//      auto-clears the just-created pending binding.
//   5. startBinding rejection surfaces an inline error and re-enables Connect.
//   6. Stale pending binding (older than BIND_PENDING_STALE_MS) surfaces an
//      error + clears immediately on mount.
//   7. Pre-existing pending binding seeds the countdown from bound_at, not
//      from "now" — a panel that opens late doesn't restart the rollback.

/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BIND_PENDING_STALE_MS,
  BIND_ROLLBACK_MS,
  renderBindingSection,
} from '../../../pipeline-tracker/src/sidepanel/binding-section.ts';
import type { ExtensionBinding } from '../../../pipeline-tracker/src/types.ts';

interface TimerHandle {
  fn: () => void;
  ms: number;
  fired: boolean;
}

function makeTimerHarness() {
  const timers: TimerHandle[] = [];
  return {
    timers,
    setTimer: (fn: () => void, ms: number) => {
      const h: TimerHandle = { fn, ms, fired: false };
      timers.push(h);
      return h;
    },
    clearTimer: (id: unknown) => {
      const h = id as TimerHandle;
      h.fired = true; // mark as inert
    },
    fireAll() {
      for (const h of timers) {
        if (!h.fired) {
          h.fired = true;
          h.fn();
        }
      }
    },
  };
}

let root: HTMLElement;

beforeEach(() => {
  root = document.createElement('div');
  document.body.appendChild(root);
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('binding section — unbound', () => {
  it('renders the Connect CTA when no binding exists', () => {
    renderBindingSection(root, {
      binding: null,
      startBinding: vi.fn(),
      clearBinding: vi.fn(),
    });
    const btn = root.querySelector('.binding-primary') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toMatch(/Connect/);
  });

  it('calls startBinding when the user clicks Connect', async () => {
    const startBinding = vi.fn().mockResolvedValue({ ok: true, delivered: 1 });
    renderBindingSection(root, {
      binding: null,
      startBinding,
      clearBinding: vi.fn(),
    });

    const btn = root.querySelector('.binding-primary') as HTMLButtonElement;
    btn.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(startBinding).toHaveBeenCalledTimes(1);
  });

  it('surfaces "Open CareerSystems first" + clears when delivered=0', async () => {
    const clearBinding = vi.fn().mockResolvedValue(undefined);
    renderBindingSection(root, {
      binding: null,
      startBinding: vi.fn().mockResolvedValue({ ok: true, delivered: 0 }),
      clearBinding,
    });

    const btn = root.querySelector('.binding-primary') as HTMLButtonElement;
    btn.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const err = root.querySelector('.binding-error') as HTMLElement;
    expect(err.textContent).toMatch(/No CareerSystems tab is open/);
    expect(clearBinding).toHaveBeenCalledTimes(1);
  });

  it('shows the SW response message when startBinding returns ok:false', async () => {
    renderBindingSection(root, {
      binding: null,
      startBinding: vi.fn().mockResolvedValue({ ok: false, message: 'not supported' }),
      clearBinding: vi.fn(),
    });

    const btn = root.querySelector('.binding-primary') as HTMLButtonElement;
    btn.click();
    await Promise.resolve();
    await Promise.resolve();
    expect((root.querySelector('.binding-error') as HTMLElement).textContent).toMatch(
      /not supported/,
    );
  });

  it('surfaces a thrown error from startBinding (sendMessage rejection)', async () => {
    renderBindingSection(root, {
      binding: null,
      startBinding: vi.fn().mockRejectedValue(new Error('runtime gone')),
      clearBinding: vi.fn(),
    });

    const btn = root.querySelector('.binding-primary') as HTMLButtonElement;
    btn.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect((root.querySelector('.binding-error') as HTMLElement).textContent).toMatch(
      /runtime gone/,
    );
  });
});

describe('binding section — pending', () => {
  it('renders the countdown computed from bound_at, not from "now"', () => {
    const boundAt = new Date('2026-05-30T10:00:00Z').toISOString();
    const harness = makeTimerHarness();
    // now() is 3s after bound_at — countdown should read 7s, not 10s.
    renderBindingSection(root, {
      binding: { token: 't', bound_at: boundAt, status: 'pending' },
      startBinding: vi.fn(),
      clearBinding: vi.fn(),
      now: () => Date.parse(boundAt) + 3_000,
      setTimer: harness.setTimer,
      clearTimer: harness.clearTimer,
    });
    expect((root.querySelector('.binding-countdown') as HTMLElement).textContent).toBe(
      '7s remaining',
    );
    expect(harness.timers).toHaveLength(1);
    expect(harness.timers[0].ms).toBe(7_000);
  });

  it('fires rollback after the remaining window and calls clearBinding', async () => {
    const boundAt = new Date('2026-05-30T10:00:00Z').toISOString();
    const clearBinding = vi.fn().mockResolvedValue(undefined);
    const harness = makeTimerHarness();
    renderBindingSection(root, {
      binding: { token: 't', bound_at: boundAt, status: 'pending' },
      startBinding: vi.fn(),
      clearBinding,
      now: () => Date.parse(boundAt),
      setTimer: harness.setTimer,
      clearTimer: harness.clearTimer,
    });

    harness.fireAll();
    await Promise.resolve();
    await Promise.resolve();

    expect(clearBinding).toHaveBeenCalledTimes(1);
    expect((root.querySelector('.binding-error') as HTMLElement).textContent).toMatch(/timeout/i);
  });

  it('treats a pending binding older than the stale window as a dead handshake', async () => {
    const boundAt = new Date('2026-05-30T10:00:00Z').toISOString();
    const clearBinding = vi.fn().mockResolvedValue(undefined);
    const harness = makeTimerHarness();
    renderBindingSection(root, {
      binding: { token: 't', bound_at: boundAt, status: 'pending' },
      startBinding: vi.fn(),
      clearBinding,
      now: () => Date.parse(boundAt) + BIND_PENDING_STALE_MS + 1_000,
      setTimer: harness.setTimer,
      clearTimer: harness.clearTimer,
    });
    // No timer should have been queued — we short-circuit to clear.
    expect(harness.timers).toHaveLength(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(clearBinding).toHaveBeenCalledTimes(1);
    expect((root.querySelector('.binding-error') as HTMLElement).textContent).toMatch(/expired/i);
  });

  it('cancels its rollback timer on destroy()', () => {
    const boundAt = new Date('2026-05-30T10:00:00Z').toISOString();
    const harness = makeTimerHarness();
    const handle = renderBindingSection(root, {
      binding: { token: 't', bound_at: boundAt, status: 'pending' },
      startBinding: vi.fn(),
      clearBinding: vi.fn(),
      now: () => Date.parse(boundAt),
      setTimer: harness.setTimer,
      clearTimer: harness.clearTimer,
    });
    expect(harness.timers).toHaveLength(1);
    expect(harness.timers[0].fired).toBe(false);
    handle.destroy();
    expect(harness.timers[0].fired).toBe(true); // marked inert by clearTimer
  });

  it('seeds the full BIND_ROLLBACK_MS budget when bound_at is now()', () => {
    const boundAt = new Date('2026-05-30T10:00:00Z').toISOString();
    const harness = makeTimerHarness();
    renderBindingSection(root, {
      binding: { token: 't', bound_at: boundAt, status: 'pending' },
      startBinding: vi.fn(),
      clearBinding: vi.fn(),
      now: () => Date.parse(boundAt),
      setTimer: harness.setTimer,
      clearTimer: harness.clearTimer,
    });
    expect(harness.timers[0].ms).toBe(BIND_ROLLBACK_MS);
  });
});

describe('binding section — handle.setBinding (stable handle)', () => {
  it('mutates body in place across state changes — root.replaceChildren runs only at initial mount', () => {
    const handle = renderBindingSection(root, {
      binding: null,
      startBinding: vi.fn(),
      clearBinding: vi.fn(),
    });
    const initialSection = root.querySelector('.binding-section');
    expect(initialSection).not.toBeNull();

    handle.setBinding({ token: 't', bound_at: '2026-05-30T10:00:00Z', status: 'confirmed' });
    expect(root.querySelector('.binding-section')).toBe(initialSection);
    expect(root.querySelector('.binding-status-confirmed')).not.toBeNull();

    handle.setBinding(null);
    expect(root.querySelector('.binding-section')).toBe(initialSection);
    expect(root.querySelector('.binding-primary')).not.toBeNull();
  });

  it('setError persists across setBinding calls (error region is a section sibling, not in body)', () => {
    const handle = renderBindingSection(root, {
      binding: null,
      startBinding: vi.fn(),
      clearBinding: vi.fn(),
    });
    handle.setError('first error');
    const errEl = root.querySelector('.binding-error') as HTMLElement;
    expect(errEl.textContent).toBe('first error');
    expect(errEl.hidden).toBe(false);

    // Storage-driven setBinding(null) must NOT wipe the sticky error —
    // that was the post-review fix that anchors errors to a section sibling
    // rather than inside body. Click handlers clear the error explicitly
    // at the start of the next user attempt.
    handle.setBinding(null);
    expect((root.querySelector('.binding-error') as HTMLElement).textContent).toBe('first error');

    handle.setBinding({ token: 't', bound_at: '2026-05-30T10:00:00Z', status: 'confirmed' });
    expect((root.querySelector('.binding-error') as HTMLElement).textContent).toBe('first error');
  });

  it('delivered=0 click flow: error message reaches the LIVE body even if a storage-driven setBinding fires mid-flight', async () => {
    // Simulates the post-fix happy case for the race the code review flagged:
    // a delivered=0 startBinding resolution interleaved with the storage
    // listener calling handle.setBinding(pending) and then setBinding(null).
    const startBinding = vi.fn().mockResolvedValue({ ok: true, delivered: 0 });
    const clearBinding = vi.fn().mockResolvedValue(undefined);
    const handle = renderBindingSection(root, {
      binding: null,
      startBinding,
      clearBinding,
    });

    const btn = root.querySelector('.binding-primary') as HTMLButtonElement;
    btn.click();

    // Simulate the SW's pending-write firing the listener mid-flight.
    handle.setBinding({ token: 't', bound_at: new Date().toISOString(), status: 'pending' });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Listener simulates the SW clearing after delivered=0 awaitClearBinding.
    handle.setBinding(null);

    // Error message must survive to a visible "Open CareerSystems" call.
    // (The click handler's setError ran AFTER setBinding(null) drew the
    // unbound body, so the error sits inside the LIVE body.)
    expect((root.querySelector('.binding-error') as HTMLElement).textContent).toMatch(
      /No CareerSystems tab is open/,
    );
  });
});

describe('binding section — confirmed', () => {
  it('renders Connected on YYYY-MM-DD + Disconnect', () => {
    const binding: ExtensionBinding = {
      token: 't',
      bound_at: '2026-05-30T10:00:00Z',
      status: 'confirmed',
    };
    renderBindingSection(root, {
      binding,
      startBinding: vi.fn(),
      clearBinding: vi.fn(),
    });
    const status = root.querySelector('.binding-status-confirmed') as HTMLElement;
    expect(status.textContent).toMatch(/Connected on/);
    // No email present → no secondary bound-at line.
    expect(root.querySelector('.binding-bound-at')).toBeNull();
    const disconnect = root.querySelector('.binding-secondary') as HTMLButtonElement;
    expect(disconnect.textContent).toBe('Disconnect');
  });

  it('shows the account email and a secondary date line when present', () => {
    const binding: ExtensionBinding = {
      token: 't',
      bound_at: '2026-05-30T10:00:00Z',
      status: 'confirmed',
      account_email: 'jane@x.com',
    };
    renderBindingSection(root, {
      binding,
      startBinding: vi.fn(),
      clearBinding: vi.fn(),
    });
    const status = root.querySelector('.binding-status-confirmed') as HTMLElement;
    expect(status.textContent).toBe('Connected as jane@x.com');
    const boundAt = root.querySelector('.binding-bound-at') as HTMLElement;
    expect(boundAt).not.toBeNull();
    expect(boundAt.textContent).toMatch(/^Connected on /);
  });

  it('renders a "Visit the app" link to the tracker page (env-aware base URL)', () => {
    const binding: ExtensionBinding = {
      token: 't',
      bound_at: '2026-05-30T10:00:00Z',
      status: 'confirmed',
    };
    renderBindingSection(root, {
      binding,
      startBinding: vi.fn(),
      clearBinding: vi.fn(),
      appBaseUrl: 'http://localhost:5173',
    });
    const link = root.querySelector('.binding-app-link') as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.getAttribute('href')).toBe('http://localhost:5173/tracker-fractional');
    expect(link.textContent).toMatch(/Visit the app/);
  });

  it('defaults the app link to production when no base URL is supplied', () => {
    renderBindingSection(root, {
      binding: { token: 't', bound_at: '2026-05-30T10:00:00Z', status: 'confirmed' },
      startBinding: vi.fn(),
      clearBinding: vi.fn(),
    });
    const link = root.querySelector('.binding-app-link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://app.cmcareersystems.com/tracker-fractional');
  });

  it('calls clearBinding when the user clicks Disconnect', async () => {
    const clearBinding = vi.fn().mockResolvedValue(undefined);
    renderBindingSection(root, {
      binding: { token: 't', bound_at: '2026-05-30T10:00:00Z', status: 'confirmed' },
      startBinding: vi.fn(),
      clearBinding,
    });
    const disconnect = root.querySelector('.binding-secondary') as HTMLButtonElement;
    disconnect.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(clearBinding).toHaveBeenCalledTimes(1);
  });

  it('surfaces an inline error when clearBinding rejects + re-enables Disconnect', async () => {
    renderBindingSection(root, {
      binding: { token: 't', bound_at: '2026-05-30T10:00:00Z', status: 'confirmed' },
      startBinding: vi.fn(),
      clearBinding: vi.fn().mockRejectedValue(new Error('storage gone')),
    });
    const disconnect = root.querySelector('.binding-secondary') as HTMLButtonElement;
    disconnect.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect((root.querySelector('.binding-error') as HTMLElement).textContent).toMatch(
      /storage gone/,
    );
    expect(disconnect.disabled).toBe(false);
  });
});
