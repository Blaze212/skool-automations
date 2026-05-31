// Spec 012 Phase 8 / D-rev-19 — rebind 3-choice modal.
//
// Coverage:
//   1. Renders three buttons in a fixed order (recommended first).
//   2. Promise resolves with the user's choice and removes the overlay.
//   3. The first button is focused on mount (keyboard users land in the
//      dialog without TAB).
//   4. Singular vs plural copy for unsyncedCount=1 vs >1.
//   5. NO default — there is no close button or Esc handler. The only way
//      to resolve is to pick.

/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  renderRebindModal,
  type RebindChoice,
} from '../../../pipeline-tracker/src/sidepanel/rebind-modal.ts';

let root: HTMLElement;

beforeEach(() => {
  root = document.createElement('div');
  document.body.appendChild(root);
});

afterEach(() => {
  document.body.innerHTML = '';
});

function getButtons(): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('.rebind-choice-btn'));
}

describe('rebind modal — render', () => {
  it('mounts the overlay + three choices in order: sync-first, move-events, delete-outbox', () => {
    void renderRebindModal(root, { unsyncedCount: 5 });
    const overlay = root.querySelector('.rebind-overlay');
    expect(overlay).not.toBeNull();

    const buttons = getButtons();
    expect(buttons).toHaveLength(3);
    expect(buttons[0].textContent).toMatch(/Sync 5 events/);
    expect(buttons[1].textContent).toMatch(/Keep events/);
    expect(buttons[2].textContent).toMatch(/Delete the unsynced events/);
  });

  it('focuses the recommended (first) button on mount', () => {
    void renderRebindModal(root, { unsyncedCount: 5 });
    const buttons = getButtons();
    expect(document.activeElement).toBe(buttons[0]);
  });

  it('uses singular copy when unsyncedCount=1', () => {
    void renderRebindModal(root, { unsyncedCount: 1 });
    expect(getButtons()[0].textContent).toMatch(/Sync 1 event\b/);
  });

  it('uses plural copy for any other count', () => {
    void renderRebindModal(root, { unsyncedCount: 42 });
    expect(getButtons()[0].textContent).toMatch(/Sync 42 events/);
  });

  it('has no close button or Escape handler (D-rev-19 — no default action)', () => {
    void renderRebindModal(root, { unsyncedCount: 3 });
    // No .first-run-close / .rebind-close should exist — the only way to
    // dismiss is to choose one of the three.
    expect(root.querySelector('.rebind-close')).toBeNull();
    // Defensive: synthesize an Escape; the modal must stay mounted.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.querySelector('.rebind-overlay')).not.toBeNull();
  });
});

describe('rebind modal — choice resolution', () => {
  async function clickAndExpect(label: RegExp, expected: RebindChoice): Promise<void> {
    const done = renderRebindModal(root, { unsyncedCount: 4 });
    const btn = getButtons().find((b) => label.test(b.textContent ?? ''));
    expect(btn).not.toBeUndefined();
    btn!.click();
    const choice = await done;
    expect(choice).toBe(expected);
    expect(root.querySelector('.rebind-overlay')).toBeNull();
  }

  it('resolves with "sync-first" when the user picks Sync', async () => {
    await clickAndExpect(/Sync \d+ event/, 'sync-first');
  });

  it('resolves with "move-events" when the user picks Keep', async () => {
    await clickAndExpect(/Keep events/, 'move-events');
  });

  it('resolves with "delete-outbox" when the user picks Delete', async () => {
    await clickAndExpect(/Delete the unsynced events/, 'delete-outbox');
  });

  it('Tab cycles between the three buttons (focus trap)', () => {
    void renderRebindModal(root, { unsyncedCount: 2 });
    const overlay = root.querySelector('.rebind-overlay') as HTMLElement;
    const buttons = getButtons();

    // Start on first button (autofocused), Tab → second.
    overlay.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(buttons[1]);

    overlay.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(buttons[2]);

    // Wrap back to first.
    overlay.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(buttons[0]);
  });

  it('disables all buttons after first click so a double-fire cannot resolve twice', async () => {
    const done = renderRebindModal(root, { unsyncedCount: 2 });
    const buttons = getButtons();
    buttons[0].click();
    // Subsequent clicks on any button after the first must be inert; the
    // promise should still resolve with the FIRST chosen value.
    buttons[1].click();
    buttons[2].click();
    const choice = await done;
    expect(choice).toBe('sync-first');
  });
});
