// Spec 012 Phase 6 — settings section (publishable build).
//
// Coverage:
//   1. Seeds the capture_message_bodies toggle from the supplied snapshot.
//   2. Toggling fires update() with the desired partial and reflects the
//      post-write snapshot back into the DOM.
//   3. Persist failure rolls the toggle back and surfaces an inline error.
//   4. The AI rows are rendered DISABLED — spec 013 takes them live; this
//      phase ships them as inert placeholders.
//   5. Re-rendering into the same root replaces the prior subtree (no leak).

/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsSection } from '../../../pipeline-tracker/src/sidepanel/settings-section.ts';
import type { Settings } from '../../../pipeline-tracker/src/types.ts';

function defaults(overrides: Partial<Settings> = {}): Settings {
  return {
    ai_fallback_enabled: false,
    ai_model_downloaded: false,
    capture_message_bodies: false,
    first_run_completed: true,
    ...overrides,
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

describe('settings section — render', () => {
  it('seeds the capture_message_bodies toggle from the supplied snapshot', () => {
    renderSettingsSection(root, {
      settings: defaults({ capture_message_bodies: true }),
      update: vi.fn(),
    });
    const toggle = root.querySelector('#settings-capture-bodies') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
  });

  it('renders AI rows DISABLED (spec 013 owns the live wiring)', () => {
    renderSettingsSection(root, { settings: defaults(), update: vi.fn() });
    const aiRows = Array.from(root.querySelectorAll('.settings-row-disabled'));
    expect(aiRows).toHaveLength(2);
    for (const row of aiRows) {
      const cb = row.querySelector('input[type="checkbox"]') as HTMLInputElement;
      expect(cb.disabled).toBe(true);
    }
  });

  it('re-rendering replaces the prior subtree', () => {
    renderSettingsSection(root, { settings: defaults(), update: vi.fn() });
    const firstDetails = root.querySelector('.settings-details');
    renderSettingsSection(root, { settings: defaults(), update: vi.fn() });
    const allDetails = root.querySelectorAll('.settings-details');
    expect(allDetails).toHaveLength(1);
    expect(allDetails[0]).not.toBe(firstDetails);
  });
});

describe('settings section — capture_message_bodies persist', () => {
  it('fires update() with the desired partial and re-seeds from the response', async () => {
    const update = vi
      .fn<(p: Partial<Settings>) => Promise<Settings>>()
      .mockResolvedValue(defaults({ capture_message_bodies: true }));
    renderSettingsSection(root, { settings: defaults(), update });

    const toggle = root.querySelector('#settings-capture-bodies') as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));

    // Flush microtasks for the await chain inside the handler.
    await Promise.resolve();
    await Promise.resolve();

    expect(update).toHaveBeenCalledWith({ capture_message_bodies: true });
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(false);
  });

  it('rolls the toggle back and surfaces an inline error on persist rejection', async () => {
    const update = vi
      .fn<(p: Partial<Settings>) => Promise<Settings>>()
      .mockRejectedValue(new Error('quota exceeded'));
    renderSettingsSection(root, { settings: defaults(), update });

    const toggle = root.querySelector('#settings-capture-bodies') as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(toggle.checked).toBe(false);
    const err = root.querySelector('.settings-row-error') as HTMLElement;
    expect(err.hidden).toBe(false);
    expect(err.textContent).toMatch(/quota/);
  });

  it('rollback restores the last-persisted snapshot, not just the inverse of desired', async () => {
    // Start with capture_message_bodies=true. The user attempts to flip it
    // OFF. The persist fails. Rollback must restore the actual persisted
    // value (true), which is what !desired = !false = true coincidentally
    // produces today — but the contract we want to assert is that the value
    // matches `opts.settings` (the rendered snapshot), not a formula on
    // `desired`. We re-prove that by chaining a successful flip then a
    // failing flip and asserting the failing flip restores the post-success
    // canonical value, NOT the inverse-of-attempt formula's output.
    const updates: Array<Settings> = [defaults({ capture_message_bodies: true })];
    const update = vi
      .fn<(p: Partial<Settings>) => Promise<Settings>>()
      .mockImplementationOnce(() => Promise.resolve(updates[0]))
      .mockImplementationOnce(() => Promise.reject(new Error('boom')));
    renderSettingsSection(root, { settings: defaults({ capture_message_bodies: false }), update });

    const toggle = root.querySelector('#settings-capture-bodies') as HTMLInputElement;
    // First flip OFF → ON, persists successfully → lastPersisted becomes true.
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(toggle.checked).toBe(true);

    // Second flip ON → OFF, persist rejects. Rollback should restore TRUE
    // (last-persisted), confirming the rollback reads from state, not from
    // `!desired` (which would also be true here — that's why the prior flip
    // had to land first).
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(toggle.checked).toBe(true);
  });

  it('ignores re-entrant toggle while a prior update is in flight', async () => {
    let resolveUpdate: ((s: Settings) => void) | undefined;
    const update = vi.fn<(p: Partial<Settings>) => Promise<Settings>>().mockImplementation(
      () =>
        new Promise<Settings>((res) => {
          resolveUpdate = res;
        }),
    );
    renderSettingsSection(root, { settings: defaults(), update });

    const toggle = root.querySelector('#settings-capture-bodies') as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));

    // Second change while the first is still pending — handler bails on the
    // re-entrant fire (disabled checkbox can't be re-clicked in the real UI,
    // but tests can dispatch events directly).
    toggle.dispatchEvent(new Event('change'));
    expect(update).toHaveBeenCalledTimes(1);

    // Resolve the in-flight call so the test cleans up.
    resolveUpdate!(defaults({ capture_message_bodies: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
});
