// Spec 012 Phase 8 / D-rev-19 — rebind 3-choice modal (publishable build).
//
// Triggered before the side panel clears a binding when the prior binding
// is in `status: 'confirmed'` AND the outbox holds unsynced events. The
// case it defends: a different CareerSystems user logs in on the same
// Chrome profile, sees Connected, and disconnects — without this modal,
// their next sync would silently inherit the prior user's outreach log
// (or alternatively, the prior user's events would be lost without a
// chance to sync them first).
//
// Per D-rev-19 the modal has NO default action. The dialog has no Close
// or Escape affordance; the user must pick exactly one of three options.
// The promise resolves with the chosen option.
//
// The choices map to side-panel actions:
//   - 'sync-first'    → dismiss without clearing the binding. User is
//                        expected to open the app, click Sync there, then
//                        come back and disconnect cleanly.
//   - 'delete-outbox' → clear outbox + per-id recovered_html, then clear
//                        the binding. Fresh start, prior events thrown
//                        away.
//   - 'move-events'   → keep the outbox, just clear the binding. When the
//                        user re-Connects to a different account, the
//                        backend sees the unsynced events arrive under
//                        the new account.
//
// The modal owns the DOM lifecycle: appends an overlay, removes it on
// choice. Multiple concurrent calls on the same root produce multiple
// overlays; caller (sidepanel.ts) gates re-entry.

export type RebindChoice = 'sync-first' | 'delete-outbox' | 'move-events';

export interface RebindModalOptions {
  /** Used in the modal copy so the user knows the scale of the decision. */
  unsyncedCount: number;
}

interface ChoiceSpec {
  value: RebindChoice;
  label: string;
  className: string;
  description: string;
}

function choiceSpecs(unsyncedCount: number): ChoiceSpec[] {
  const word = unsyncedCount === 1 ? 'event' : 'events';
  return [
    {
      value: 'sync-first',
      label: `Sync ${unsyncedCount} ${word} to the current account first`,
      className: 'rebind-choice-primary',
      description:
        'Recommended. Cancel disconnect, switch to your CareerSystems tab, click Sync, then come back here to disconnect cleanly.',
    },
    {
      value: 'move-events',
      label: 'Keep events for the new account',
      className: 'rebind-choice-secondary',
      description: `Disconnect now and keep the ${unsyncedCount} unsynced ${word}. When you connect a different account, these events will sync there instead.`,
    },
    {
      value: 'delete-outbox',
      label: 'Delete the unsynced events',
      className: 'rebind-choice-danger',
      description: `Disconnect and discard all ${unsyncedCount} unsynced ${word}. This cannot be undone.`,
    },
  ];
}

export function renderRebindModal(
  root: HTMLElement,
  opts: RebindModalOptions,
): Promise<RebindChoice> {
  return new Promise<RebindChoice>((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'rebind-overlay first-run-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'rebind-title');

    const dialog = document.createElement('div');
    dialog.className = 'rebind-dialog first-run-dialog';

    const title = document.createElement('h1');
    title.id = 'rebind-title';
    title.className = 'first-run-title';
    title.textContent = 'You have unsynced events';

    const intro = document.createElement('p');
    intro.className = 'first-run-intro';
    intro.textContent =
      `Before you disconnect, choose what should happen to the ${opts.unsyncedCount} ` +
      `event${opts.unsyncedCount === 1 ? '' : 's'} that haven't been synced yet.`;

    dialog.append(title, intro);

    const list = document.createElement('div');
    list.className = 'rebind-choices';

    function pick(choice: RebindChoice): void {
      // Disable every button at first click so a double-fire on a fast
      // pointer can't resolve twice. We resolve outside the click handler
      // to ensure the DOM teardown happens before the caller's continuation.
      for (const btn of Array.from(list.querySelectorAll<HTMLButtonElement>('button'))) {
        btn.disabled = true;
      }
      overlay.remove();
      resolve(choice);
    }

    for (const spec of choiceSpecs(opts.unsyncedCount)) {
      const row = document.createElement('div');
      row.className = 'rebind-choice';

      const button = document.createElement('button');
      button.type = 'button';
      button.className = `rebind-choice-btn ${spec.className}`;
      button.textContent = spec.label;
      button.addEventListener('click', () => pick(spec.value));

      const desc = document.createElement('div');
      desc.className = 'rebind-choice-desc';
      desc.textContent = spec.description;

      row.append(button, desc);
      list.appendChild(row);
    }

    dialog.appendChild(list);
    overlay.appendChild(dialog);
    root.appendChild(overlay);

    /**
     * Tab focus trap — enforces D-rev-19's "must pick exactly one" for
     * keyboard users. Without this, Tab from the last button moves focus
     * into the underlying side panel and the user can interact with the
     * binding/events surface while the modal is still mounted.
     */
    overlay.addEventListener('keydown', (ev: KeyboardEvent) => {
      if (ev.key !== 'Tab') return;
      const focusables = Array.from(
        list.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
      );
      if (focusables.length === 0) return;
      const active = document.activeElement as HTMLElement | null;
      const idx = active ? focusables.indexOf(active as HTMLButtonElement) : -1;
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

    // Focus the recommended (first) button so keyboard users have a
    // sensible starting point. There's NO Escape handler — D-rev-19 says
    // no default action; the user must pick explicitly.
    (list.querySelector('button') as HTMLButtonElement | null)?.focus();
  });
}
