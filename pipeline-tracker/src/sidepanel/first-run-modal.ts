// Spec 012 Phase 6 — first-run modal (publishable build).
//
// Per D8: a single screen with three disclosure points and the
// `capture_message_bodies` opt-in toggle (default OFF).
//
// Per D-rev-17: the Close button is DISABLED until the user explicitly
// interacts with the toggle. The point is to prevent a user from dismissing
// the modal by reflex without consciously choosing whether to opt into
// message-body capture. Toggling on then off again still counts — the user
// has made a choice.
//
// On close: persists `settings.first_run_completed = true` plus the final
// `capture_message_bodies` value via the supplied commit callback. The caller
// (sidepanel.ts) is responsible for the storage round-trip; this module only
// owns the DOM + interaction state machine. Tests assert both that the close
// button gates correctly and that the right patch is committed.
//
// The modal lives in its own DOM subtree appended to the host root. On close
// it removes itself, so calling renderFirstRunModal twice on the same root is
// safe — the second call mounts a fresh subtree.

import type { Settings } from '../types.ts';

export interface FirstRunCommit {
  capture_message_bodies: boolean;
  first_run_completed: true;
}

export interface RenderFirstRunModalOptions {
  /** Initial settings snapshot to seed the toggle state. */
  settings: Settings;
  /**
   * Persist the final commit. Called once with `first_run_completed: true`
   * and the toggle's final value when the user clicks Close. If the commit
   * rejects, the modal stays mounted with an inline error so the user can
   * retry — closing the modal on a storage failure would silently swallow
   * the opt-in choice.
   */
  commit: (patch: FirstRunCommit) => Promise<void>;
}

const TOGGLE_LABEL = 'Capture message bodies';
const TOGGLE_HELP =
  'Off by default. Turn on to include the text of your LinkedIn messages in captured events ' +
  'for conversion-rate analysis (which opening lines actually get replies). Bodies stay on ' +
  'your device until you sync, same as everything else.';

/**
 * Render the first-run modal into `root` and return a Promise that resolves
 * once the user closes it AND the commit completes. The Promise never rejects
 * — commit failures stay surfaced inside the modal until the user either
 * retries successfully or, in the worst case, closes the panel; the caller's
 * .then() runs only on a clean commit.
 */
export function renderFirstRunModal(
  root: HTMLElement,
  opts: RenderFirstRunModalOptions,
): Promise<void> {
  return new Promise<void>((resolve) => {
    // Local interaction state. `touched` is the D-rev-17 gate — it flips the
    // first time the user fires the toggle's change event and never flips back.
    let touched = false;
    let captureOn = opts.settings.capture_message_bodies;
    let committing = false;

    const overlay = document.createElement('div');
    overlay.className = 'first-run-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'first-run-title');

    const dialog = document.createElement('div');
    dialog.className = 'first-run-dialog';

    const title = document.createElement('h1');
    title.id = 'first-run-title';
    title.className = 'first-run-title';
    title.textContent = 'Welcome to Pipeline Tracker';

    const intro = document.createElement('p');
    intro.className = 'first-run-intro';
    intro.textContent =
      'Pipeline Tracker watches your outbound LinkedIn activity and logs it for your ' +
      'CareerSystems pipeline. Before you start, here is what that means in practice.';

    const list = document.createElement('ol');
    list.className = 'first-run-points';

    const bullets: Array<[string, string]> = [
      [
        'What we capture',
        'The name, title, and profile URL of LinkedIn people you send connection requests, ' +
          'direct messages, or InMail to. Optionally — only if you turn it on below — the ' +
          'body of the message itself.',
      ],
      [
        'Where it is stored',
        'Locally in this extension on your device. Nothing is uploaded automatically.',
      ],
      [
        'Where it goes',
        'Nothing leaves until you open app.cmcareersystems.com and click Sync. The page ' +
          'pulls events out of the extension over your existing logged-in session.',
      ],
    ];

    for (const [heading, body] of bullets) {
      const li = document.createElement('li');
      const strong = document.createElement('strong');
      strong.textContent = heading;
      const span = document.createElement('span');
      span.textContent = ` — ${body}`;
      li.append(strong, span);
      list.appendChild(li);
    }

    // Toggle group — checkbox + label + help text. We use a real checkbox
    // (not a custom switch) so screen readers and keyboard navigation work
    // for free.
    const toggleRow = document.createElement('label');
    toggleRow.className = 'first-run-toggle';

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.id = 'first-run-capture-bodies';
    toggle.checked = captureOn;

    const toggleText = document.createElement('div');
    toggleText.className = 'first-run-toggle-text';

    const toggleLabel = document.createElement('div');
    toggleLabel.className = 'first-run-toggle-label';
    toggleLabel.textContent = TOGGLE_LABEL;

    const toggleHelp = document.createElement('div');
    toggleHelp.className = 'first-run-toggle-help';
    toggleHelp.textContent = TOGGLE_HELP;

    toggleText.append(toggleLabel, toggleHelp);
    toggleRow.append(toggle, toggleText);

    // Close button — disabled until `touched`.
    const actions = document.createElement('div');
    actions.className = 'first-run-actions';

    const hint = document.createElement('span');
    hint.className = 'first-run-hint';
    hint.textContent = 'Choose Capture message bodies on or off to continue.';

    // "Skip for now" — revealed only after a commit failure. Resolves the
    // promise WITHOUT persisting (first_run_completed stays false, so the
    // modal returns next session). Without this, a persistent
    // chrome.storage.local failure would leave the modal-mount path stuck
    // indefinitely; surfacing a non-persisting escape unblocks the user and
    // tells the caller "we tried, take your best shot anyway."
    const skipBtn = document.createElement('button');
    skipBtn.type = 'button';
    skipBtn.className = 'first-run-skip';
    skipBtn.textContent = 'Skip for now';
    skipBtn.hidden = true;

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'first-run-close';
    closeBtn.disabled = true;
    closeBtn.textContent = 'Got it';

    const errorLine = document.createElement('div');
    errorLine.className = 'first-run-error';
    errorLine.setAttribute('role', 'alert');
    errorLine.hidden = true;

    actions.append(hint, skipBtn, closeBtn);

    dialog.append(title, intro, list, toggleRow, actions, errorLine);
    overlay.appendChild(dialog);
    root.appendChild(overlay);

    // Move focus into the dialog so keyboard users land somewhere sensible.
    toggle.focus();

    /**
     * Tab focus trap — keeps keyboard navigation inside the dialog. Without
     * this, the disabled close button is unfocusable so Tab would jump past
     * it into the underlying side panel, contradicting role=dialog +
     * aria-modal=true. We cycle between the toggle and whichever of
     * skipBtn / closeBtn are currently enabled+visible.
     */
    function focusableInDialog(): HTMLElement[] {
      const list: HTMLElement[] = [toggle];
      if (!skipBtn.hidden && !skipBtn.disabled) list.push(skipBtn);
      if (!closeBtn.disabled) list.push(closeBtn);
      return list;
    }

    overlay.addEventListener('keydown', (ev: KeyboardEvent) => {
      if (ev.key !== 'Tab') return;
      const focusables = focusableInDialog();
      if (focusables.length === 0) return;
      const active = document.activeElement as HTMLElement | null;
      const idx = active ? focusables.indexOf(active) : -1;
      // If focus is outside the cycle (e.g. on the overlay itself) or at the
      // boundary, wrap to the other end. This is a tight trap suitable for
      // a 3-control dialog; a heavier focus-trap library would over-engineer.
      let next: number;
      if (idx === -1) {
        next = ev.shiftKey ? focusables.length - 1 : 0;
      } else {
        next = ev.shiftKey ? idx - 1 : idx + 1;
        if (next < 0) next = focusables.length - 1;
        if (next >= focusables.length) next = 0;
      }
      ev.preventDefault();
      focusables[next].focus();
    });

    toggle.addEventListener('change', () => {
      captureOn = toggle.checked;
      touched = true;
      hint.hidden = true;
      closeBtn.disabled = false;
    });

    skipBtn.addEventListener('click', () => {
      overlay.remove();
      resolve();
    });

    closeBtn.addEventListener('click', async () => {
      if (!touched || committing) return;
      committing = true;
      closeBtn.disabled = true;
      toggle.disabled = true;
      errorLine.hidden = true;
      try {
        await opts.commit({
          capture_message_bodies: captureOn,
          first_run_completed: true,
        });
        overlay.remove();
        resolve();
      } catch (err) {
        errorLine.hidden = false;
        errorLine.textContent =
          'Could not save your choice: ' +
          (err instanceof Error ? err.message : String(err)) +
          '. Try again, or Skip to dismiss without saving.';
        // Re-enable so the user can retry. `touched` stays true (the choice
        // has been made; only the persist failed). Reveal the Skip
        // affordance so the user has an explicit non-persisting exit if
        // retries keep failing.
        closeBtn.disabled = false;
        toggle.disabled = false;
        skipBtn.hidden = false;
        committing = false;
      }
    });
  });
}
