// Spec 012 Phase 6 — settings section (publishable build).
//
// Persistent settings UI rendered in the side panel above the unsynced events
// list. Always visible, collapsed by default via <details>. Holds:
//
//   1. `capture_message_bodies` toggle — owned by this spec. Mirrors the
//      first-run modal toggle so the user can change their mind later.
//   2. AI fallback rows — STUBBED and disabled here. Spec 013 owns the actual
//      `LanguageModel` plumbing (availability check, model download, the
//      `ai_fallback_enabled` toggle going live). Until 013 ships, the rows are
//      rendered for visual continuity (so the section isn't a one-line
//      surface) with `disabled` + a "Coming soon" note. The rows DO NOT call
//      settingsStore.update for those fields; they have no effect on storage.
//
// On capture-bodies change: calls the supplied `update` callback synchronously
// (returns a Promise), which is responsible for the storage round-trip. UI
// reflects the optimistic next state immediately; on persist failure the
// caller's promise rejection rolls the toggle back via an inline error
// message + checkbox revert.

import type { Settings } from '../types.ts';

export interface RenderSettingsSectionOptions {
  /** Current persisted settings — used to seed toggle states. */
  settings: Settings;
  /**
   * Persist a partial settings patch. Returns the resulting Settings so the
   * UI can re-seed from the post-write snapshot (in case server-side defaults
   * or other fields get filled in). On rejection, the UI rolls back the
   * affected control and surfaces an inline error.
   */
  update: (patch: Partial<Settings>) => Promise<Settings>;
}

const CAPTURE_BODIES_HELP =
  'Include the body of your LinkedIn messages in captured events. Off by default. ' +
  'Bodies stay on your device until you sync.';

export function renderSettingsSection(root: HTMLElement, opts: RenderSettingsSectionOptions): void {
  root.replaceChildren();

  const details = document.createElement('details');
  details.className = 'settings-details';

  const summary = document.createElement('summary');
  summary.className = 'settings-summary';
  summary.textContent = 'Settings';
  details.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'settings-body';

  // === capture_message_bodies ===
  const captureRow = document.createElement('label');
  captureRow.className = 'settings-row';

  const captureToggle = document.createElement('input');
  captureToggle.type = 'checkbox';
  captureToggle.id = 'settings-capture-bodies';
  captureToggle.checked = opts.settings.capture_message_bodies;

  const captureText = document.createElement('div');
  captureText.className = 'settings-row-text';

  const captureLabel = document.createElement('div');
  captureLabel.className = 'settings-row-label';
  captureLabel.textContent = 'Capture message bodies';

  const captureHelp = document.createElement('div');
  captureHelp.className = 'settings-row-help';
  captureHelp.textContent = CAPTURE_BODIES_HELP;

  captureText.append(captureLabel, captureHelp);
  captureRow.append(captureToggle, captureText);

  const captureError = document.createElement('div');
  captureError.className = 'settings-row-error';
  captureError.setAttribute('role', 'alert');
  captureError.hidden = true;

  // Track the last successfully-persisted value so rollback on a failed
  // update writes the actual canonical state instead of `!desired` (the
  // simple inverse is correct today but breaks if a future
  // chrome.storage.onChanged listener re-seeds .checked mid-flight).
  let lastPersisted = opts.settings.capture_message_bodies;
  let inFlight = false;
  captureToggle.addEventListener('change', async () => {
    if (inFlight) return;
    const desired = captureToggle.checked;
    inFlight = true;
    captureToggle.disabled = true;
    captureError.hidden = true;
    try {
      const next = await opts.update({ capture_message_bodies: desired });
      // Re-seed from the post-write snapshot — protects against an external
      // mutation racing with the toggle (e.g. settings reset somewhere else).
      lastPersisted = next.capture_message_bodies;
      captureToggle.checked = lastPersisted;
    } catch (err) {
      captureToggle.checked = lastPersisted;
      captureError.hidden = false;
      captureError.textContent =
        'Could not save: ' + (err instanceof Error ? err.message : String(err));
    } finally {
      captureToggle.disabled = false;
      inFlight = false;
    }
  });

  body.append(captureRow, captureError);

  // === AI fallback stubs (owned by spec 013; inert here) ===
  const aiHeading = document.createElement('h3');
  aiHeading.className = 'settings-subheading';
  aiHeading.textContent = 'On-device AI (coming soon)';
  body.appendChild(aiHeading);

  const aiRows: Array<{ label: string; help: string }> = [
    {
      label: 'Enable AI fallback',
      help:
        'When LinkedIn changes its HTML and the normal scrape misses a field, ' +
        'recover the field on-device with Chrome’s Prompt API.',
    },
    {
      label: 'Download the on-device model',
      help: 'About 2 GB. Downloads once, runs locally; nothing sent to a server.',
    },
  ];

  for (const row of aiRows) {
    const r = document.createElement('label');
    r.className = 'settings-row settings-row-disabled';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.disabled = true;

    const text = document.createElement('div');
    text.className = 'settings-row-text';

    const lbl = document.createElement('div');
    lbl.className = 'settings-row-label';
    lbl.textContent = row.label;

    const help = document.createElement('div');
    help.className = 'settings-row-help';
    help.textContent = row.help;

    text.append(lbl, help);
    r.append(cb, text);
    body.appendChild(r);
  }

  details.appendChild(body);
  root.appendChild(details);
}
