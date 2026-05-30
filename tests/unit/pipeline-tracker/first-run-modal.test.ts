// Spec 012 Phase 6 — first-run modal (publishable build).
//
// Coverage:
//   1. Modal renders the 3-point disclosure + capture toggle (default OFF).
//   2. D-rev-17 — close button is disabled until the user fires the toggle's
//      change event; first toggle off→on→off still satisfies the gate.
//   3. On close, the supplied commit callback receives the final toggle value
//      and first_run_completed: true, and the modal removes itself.
//   4. Commit rejection keeps the modal mounted with an inline error message
//      and re-enables the close button so the user can retry.
//   5. The returned Promise only resolves after a successful commit.
//   6. Re-mounting the modal on the same root produces a fresh subtree —
//      defense against accidental double mount.

/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderFirstRunModal } from '../../../pipeline-tracker/src/sidepanel/first-run-modal.ts';
import type { Settings } from '../../../pipeline-tracker/src/types.ts';

function defaultSettings(): Settings {
  return {
    ai_fallback_enabled: false,
    ai_model_downloaded: false,
    capture_message_bodies: false,
    first_run_completed: false,
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

describe('first-run modal — rendering', () => {
  it('mounts the disclosure points + toggle (default OFF) on first render', () => {
    void renderFirstRunModal(root, { settings: defaultSettings(), commit: vi.fn() });

    expect(root.querySelector('.first-run-overlay')).not.toBeNull();
    expect(root.querySelector('.first-run-title')?.textContent).toMatch(/Welcome to Pipeline/);
    const bullets = Array.from(root.querySelectorAll('.first-run-points li'));
    expect(bullets).toHaveLength(3);

    const toggle = root.querySelector('#first-run-capture-bodies') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
  });

  it('seeds the toggle from the existing settings snapshot', () => {
    const settings = defaultSettings();
    settings.capture_message_bodies = true;
    void renderFirstRunModal(root, { settings, commit: vi.fn() });
    const toggle = root.querySelector('#first-run-capture-bodies') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
  });
});

describe('first-run modal — D-rev-17 close gate', () => {
  it('disables the close button until the user fires the toggle change event', () => {
    void renderFirstRunModal(root, { settings: defaultSettings(), commit: vi.fn() });

    const closeBtn = root.querySelector('.first-run-close') as HTMLButtonElement;
    expect(closeBtn.disabled).toBe(true);

    // Just CHANGING the checked property doesn't count — the gate keys off
    // the user-driven `change` event. (Defensive: programmatic .checked = true
    // could happen via dev-tools or a test harness; only deliberate user
    // interaction unlocks the close.)
    const toggle = root.querySelector('#first-run-capture-bodies') as HTMLInputElement;
    toggle.checked = true;
    expect(closeBtn.disabled).toBe(true);

    toggle.dispatchEvent(new Event('change'));
    expect(closeBtn.disabled).toBe(false);
  });

  it('keeps the gate satisfied after on → off (the choice has been made)', () => {
    void renderFirstRunModal(root, { settings: defaultSettings(), commit: vi.fn() });

    const closeBtn = root.querySelector('.first-run-close') as HTMLButtonElement;
    const toggle = root.querySelector('#first-run-capture-bodies') as HTMLInputElement;

    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));

    expect(closeBtn.disabled).toBe(false);
  });

  it('clicking close before the gate releases is a no-op', async () => {
    const commit = vi.fn();
    void renderFirstRunModal(root, { settings: defaultSettings(), commit });

    const closeBtn = root.querySelector('.first-run-close') as HTMLButtonElement;
    // Force-click the disabled button — modern HTMLButtonElement.click() is
    // a no-op when disabled, but click via event dispatch is not, so we use
    // .click() to mirror real user interaction (which is also a no-op).
    closeBtn.click();
    await Promise.resolve();
    expect(commit).not.toHaveBeenCalled();
    expect(root.querySelector('.first-run-overlay')).not.toBeNull();
  });
});

describe('first-run modal — commit + close', () => {
  it('commits with the final toggle value and first_run_completed:true on close', async () => {
    const commit = vi.fn().mockResolvedValue(undefined);
    const done = renderFirstRunModal(root, { settings: defaultSettings(), commit });

    const toggle = root.querySelector('#first-run-capture-bodies') as HTMLInputElement;
    const closeBtn = root.querySelector('.first-run-close') as HTMLButtonElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    closeBtn.click();
    await done;

    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith({
      capture_message_bodies: true,
      first_run_completed: true,
    });
    expect(root.querySelector('.first-run-overlay')).toBeNull();
  });

  it('passes the toggle-off case through commit too (user explicitly declined)', async () => {
    const commit = vi.fn().mockResolvedValue(undefined);
    const done = renderFirstRunModal(root, { settings: defaultSettings(), commit });

    const toggle = root.querySelector('#first-run-capture-bodies') as HTMLInputElement;
    const closeBtn = root.querySelector('.first-run-close') as HTMLButtonElement;
    // User toggled on then back off — close gate is satisfied and the value
    // committed is the final OFF state.
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    closeBtn.click();
    await done;

    expect(commit).toHaveBeenCalledWith({
      capture_message_bodies: false,
      first_run_completed: true,
    });
  });

  it('keeps the modal mounted with an inline error if commit rejects', async () => {
    const commit = vi
      .fn()
      .mockRejectedValueOnce(new Error('chrome.storage.local quota exceeded'))
      .mockResolvedValueOnce(undefined);
    const done = renderFirstRunModal(root, { settings: defaultSettings(), commit });

    const toggle = root.querySelector('#first-run-capture-bodies') as HTMLInputElement;
    const closeBtn = root.querySelector('.first-run-close') as HTMLButtonElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));

    closeBtn.click();
    // Let the commit promise reject + the catch path run.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(root.querySelector('.first-run-overlay')).not.toBeNull();
    const errorLine = root.querySelector('.first-run-error') as HTMLElement;
    expect(errorLine.hidden).toBe(false);
    expect(errorLine.textContent).toMatch(/quota/i);
    expect(closeBtn.disabled).toBe(false);

    // Retry succeeds → modal closes + done resolves.
    closeBtn.click();
    await done;
    expect(commit).toHaveBeenCalledTimes(2);
    expect(root.querySelector('.first-run-overlay')).toBeNull();
  });
});

describe('first-run modal — skip-for-now after commit failure', () => {
  it('reveals the Skip button only after a commit attempt fails', async () => {
    const commit = vi.fn().mockRejectedValue(new Error('quota'));
    void renderFirstRunModal(root, { settings: defaultSettings(), commit });

    const skipBtn = root.querySelector('.first-run-skip') as HTMLButtonElement;
    expect(skipBtn.hidden).toBe(true);

    const toggle = root.querySelector('#first-run-capture-bodies') as HTMLInputElement;
    const closeBtn = root.querySelector('.first-run-close') as HTMLButtonElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    closeBtn.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(skipBtn.hidden).toBe(false);
  });

  it('clicking Skip resolves the promise WITHOUT committing (modal returns next session)', async () => {
    const commit = vi.fn().mockRejectedValue(new Error('quota'));
    const done = renderFirstRunModal(root, { settings: defaultSettings(), commit });

    const toggle = root.querySelector('#first-run-capture-bodies') as HTMLInputElement;
    const closeBtn = root.querySelector('.first-run-close') as HTMLButtonElement;
    const skipBtn = root.querySelector('.first-run-skip') as HTMLButtonElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    closeBtn.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    skipBtn.click();
    await done;

    expect(commit).toHaveBeenCalledTimes(1); // the one failed attempt; Skip does not re-attempt
    expect(root.querySelector('.first-run-overlay')).toBeNull();
  });
});

describe('first-run modal — focus trap', () => {
  it('Tab from the toggle stays in the dialog when the close button is disabled', () => {
    void renderFirstRunModal(root, { settings: defaultSettings(), commit: vi.fn() });

    const overlay = root.querySelector('.first-run-overlay') as HTMLElement;
    const toggle = root.querySelector('#first-run-capture-bodies') as HTMLInputElement;
    toggle.focus();

    // Close is still disabled; Skip is hidden. Only the toggle is focusable.
    // Pressing Tab must cycle back to itself, not escape to the document body.
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    overlay.dispatchEvent(ev);

    expect(document.activeElement).toBe(toggle);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('Tab cycles between toggle and close after the gate releases', () => {
    void renderFirstRunModal(root, { settings: defaultSettings(), commit: vi.fn() });

    const overlay = root.querySelector('.first-run-overlay') as HTMLElement;
    const toggle = root.querySelector('#first-run-capture-bodies') as HTMLInputElement;
    const closeBtn = root.querySelector('.first-run-close') as HTMLButtonElement;

    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    expect(closeBtn.disabled).toBe(false);

    toggle.focus();
    overlay.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(closeBtn);

    overlay.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(toggle);
  });
});

describe('first-run modal — double mount', () => {
  it('re-mounting on the same root appends a second subtree (caller owns DOM lifecycle)', () => {
    void renderFirstRunModal(root, { settings: defaultSettings(), commit: vi.fn() });
    void renderFirstRunModal(root, { settings: defaultSettings(), commit: vi.fn() });
    // The module does not deduplicate — its job is to mount + remove its own
    // subtree on close. If the caller mounts twice they get two overlays; the
    // sidepanel.ts entry point gates on `first_run_completed` so this in
    // practice cannot happen, but the test pins the behavior so a future
    // change doesn't introduce silent dedup logic that masks a caller bug.
    expect(root.querySelectorAll('.first-run-overlay')).toHaveLength(2);
  });
});
