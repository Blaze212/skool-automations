// Spec 012 Phase 6 — settings section (publishable build).
//
// Persistent settings UI rendered in the side panel above the unsynced events
// list. Always visible, collapsed by default via <details>. Holds:
//
//   1. `capture_message_bodies` toggle — owned by this spec. Mirrors the
//      first-run modal toggle so the user can change their mind later.
//   2. On-device AI recovery (spec 013) — LIVE. The `ai_fallback_enabled`
//      toggle persists through `update`; an availability probe drives the UI
//      state (ready / download CTA / downloading / unsupported); the download
//      button triggers the ~2 GB model fetch with a progress readout. All
//      `LanguageModel.*` access lives in @cs/scraping-core (spec 013 guard #1);
//      this module only consumes the exported helpers.
//
// On any toggle change: calls the supplied `update` callback (returns a
// Promise), which is responsible for the storage round-trip. UI reflects the
// optimistic next state immediately; on persist failure the caller's promise
// rejection rolls the toggle back via an inline error message + checkbox
// revert.

import type { Settings, ProductMode } from '../types.ts';
import { downloadModel, refreshAvailability, type AiAvailability } from '@cs/scraping-core';

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
  /** Probe on-device model availability. Defaults to the @cs/scraping-core
   * helper; injectable for tests. */
  checkAvailability?: () => Promise<AiAvailability>;
  /** Trigger the model download with a progress callback. Defaults to the
   * @cs/scraping-core helper; injectable for tests. */
  startModelDownload?: (onProgress: (fraction: number) => void) => Promise<AiAvailability>;
  /**
   * Optional — render the CareerSystems sync (binding) UI into a slot at the
   * bottom of the dropdown. spec 016 UI: the full connect/disconnect controls
   * live in Settings; only a compact "Connected as …" line stays on the main
   * panel. Called once with the slot element after the body is built.
   */
  renderBindingInto?: (slot: HTMLElement) => void;
  /**
   * True when the extension is bound to a CareerSystems account. Disables the
   * product_mode toggle (mode is frozen while bound; disconnect to change it).
   */
  isBound?: boolean;
}

const CAPTURE_BODIES_HELP =
  'Include the body of your captured messages in events. Off by default. ' +
  'Bodies stay on your device until you sync.';

const PRODUCT_MODE_HELP =
  'Job Seeker shows connection, accepted, and message stages. ' +
  'Fractional shows all pipeline stages including value-add and follow-up.';

const AI_FALLBACK_HELP =
  'When a dragged or pasted selection is messy and the basic parse misses a field, ' +
  'extract it on-device with Chrome’s built-in AI. Nothing is sent to a server.';

const DEBUG_LOGGING_HELP =
  'Log the raw captured selection and the on-device AI prompt/response to the ' +
  'console for troubleshooting. Off by default — these logs can contain private ' +
  'message content, so only turn this on when capturing a sample for a bug report.';

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

  // === Owner name (spec 016) — also collected in the first-run modal; editable
  // here so an already-onboarded user can set/change it. Threaded into the
  // extraction prompt (ownerName) to identify the user's own thread messages. ===
  const nameRow = document.createElement('div');
  nameRow.className = 'settings-row';

  const nameText = document.createElement('div');
  nameText.className = 'settings-row-text';

  const nameLabel = document.createElement('div');
  nameLabel.className = 'settings-row-label';
  nameLabel.textContent = 'Your name';

  const nameHelp = document.createElement('div');
  nameHelp.className = 'settings-row-help';
  nameHelp.textContent = 'Labels your captures and identifies your own messages in a thread.';

  const nameInputs = document.createElement('div');
  nameInputs.className = 'settings-name-inputs';

  const firstNameInput = document.createElement('input');
  firstNameInput.type = 'text';
  firstNameInput.id = 'settings-owner-first-name';
  firstNameInput.className = 'settings-name-input';
  firstNameInput.placeholder = 'First name';
  firstNameInput.autocomplete = 'given-name';
  firstNameInput.value = (opts.settings.owner_first_name ?? '').trim();

  const lastNameInput = document.createElement('input');
  lastNameInput.type = 'text';
  lastNameInput.id = 'settings-owner-last-name';
  lastNameInput.className = 'settings-name-input';
  lastNameInput.placeholder = 'Last name';
  lastNameInput.autocomplete = 'family-name';
  lastNameInput.value = (opts.settings.owner_last_name ?? '').trim();

  nameInputs.append(firstNameInput, lastNameInput);
  nameText.append(nameLabel, nameHelp, nameInputs);
  nameRow.append(nameText);

  const nameError = document.createElement('div');
  // Distinct class (not `.settings-row-error`) so existing tests that select the
  // first `.settings-row-error` still resolve to the capture-bodies row error.
  nameError.className = 'settings-name-error';
  nameError.setAttribute('role', 'alert');
  nameError.hidden = true;

  // Persist on blur (change). Both fields save together; on failure, roll the
  // inputs back to the last-persisted values and surface an inline error.
  let nameLast = {
    first: (opts.settings.owner_first_name ?? '').trim(),
    last: (opts.settings.owner_last_name ?? '').trim(),
  };
  let nameInFlight = false;
  async function saveName(): Promise<void> {
    if (nameInFlight) return;
    const first = firstNameInput.value.trim();
    const last = lastNameInput.value.trim();
    if (first === nameLast.first && last === nameLast.last) return; // no-op
    nameInFlight = true;
    firstNameInput.disabled = true;
    lastNameInput.disabled = true;
    nameError.hidden = true;
    try {
      const next = await opts.update({ owner_first_name: first, owner_last_name: last });
      nameLast = {
        first: (next.owner_first_name ?? '').trim(),
        last: (next.owner_last_name ?? '').trim(),
      };
      firstNameInput.value = nameLast.first;
      lastNameInput.value = nameLast.last;
    } catch (err) {
      firstNameInput.value = nameLast.first;
      lastNameInput.value = nameLast.last;
      nameError.hidden = false;
      nameError.textContent =
        'Could not save: ' + (err instanceof Error ? err.message : String(err));
    } finally {
      firstNameInput.disabled = false;
      lastNameInput.disabled = false;
      nameInFlight = false;
    }
  }
  firstNameInput.addEventListener('change', () => void saveName());
  lastNameInput.addEventListener('change', () => void saveName());

  body.append(nameRow, nameError);

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

  // === product_mode ===
  const modeRow = document.createElement('div');
  modeRow.className = 'settings-row';

  const modeText = document.createElement('div');
  modeText.className = 'settings-row-text';

  const modeLabel = document.createElement('div');
  modeLabel.className = 'settings-row-label';
  modeLabel.textContent = 'Product mode';

  const modeHelp = document.createElement('div');
  modeHelp.className = 'settings-row-help';
  modeHelp.textContent = PRODUCT_MODE_HELP;

  modeText.append(modeLabel, modeHelp);

  const modeSelect = document.createElement('select');
  modeSelect.id = 'settings-product-mode';
  const modeOptJobseeker = document.createElement('option');
  modeOptJobseeker.value = 'jobseeker';
  modeOptJobseeker.textContent = 'Job Seeker';
  const modeOptFractional = document.createElement('option');
  modeOptFractional.value = 'fractional';
  modeOptFractional.textContent = 'Fractional';
  modeSelect.append(modeOptJobseeker, modeOptFractional);
  modeSelect.value = opts.settings.product_mode ?? 'jobseeker';

  modeRow.append(modeText, modeSelect);

  const modeError = document.createElement('div');
  modeError.className = 'settings-row-error';
  modeError.setAttribute('role', 'alert');
  modeError.hidden = true;

  // The "Disconnect to change" hint only renders while bound (mode is frozen
  // then); when unbound the select is editable and no hint is shown.
  if (opts.isBound) {
    modeSelect.disabled = true;
    const modeHint = document.createElement('div');
    modeHint.className = 'settings-row-help';
    modeHint.textContent = 'Disconnect to change.';
    modeRow.appendChild(modeHint);
  }

  let modeLastPersisted: ProductMode = opts.settings.product_mode ?? 'jobseeker';
  let modeInFlight = false;
  modeSelect.addEventListener('change', async () => {
    if (modeInFlight) return;
    const desired = modeSelect.value as ProductMode;
    modeInFlight = true;
    modeSelect.disabled = true;
    modeError.hidden = true;
    try {
      const next = await opts.update({ product_mode: desired });
      modeLastPersisted = next.product_mode ?? 'jobseeker';
      modeSelect.value = modeLastPersisted;
    } catch (err) {
      modeSelect.value = modeLastPersisted;
      modeError.hidden = false;
      modeError.textContent =
        'Could not save: ' + (err instanceof Error ? err.message : String(err));
    } finally {
      if (!opts.isBound) modeSelect.disabled = false;
      modeInFlight = false;
    }
  });

  body.append(modeRow, modeError);

  // === On-device AI recovery (spec 013) ===
  const checkAvailability = opts.checkAvailability ?? refreshAvailability;
  const startModelDownload = opts.startModelDownload ?? downloadModel;

  const aiHeading = document.createElement('h3');
  aiHeading.className = 'settings-subheading';
  aiHeading.textContent = 'On-device AI recovery';
  body.appendChild(aiHeading);

  const aiRow = document.createElement('label');
  aiRow.className = 'settings-row';

  const aiToggle = document.createElement('input');
  aiToggle.type = 'checkbox';
  aiToggle.id = 'settings-ai-fallback';
  aiToggle.checked = opts.settings.ai_fallback_enabled;
  aiToggle.disabled = true; // until the availability probe resolves

  const aiText = document.createElement('div');
  aiText.className = 'settings-row-text';

  const aiLabel = document.createElement('div');
  aiLabel.className = 'settings-row-label';
  aiLabel.textContent = 'Enable on-device AI recovery';

  const aiHelp = document.createElement('div');
  aiHelp.className = 'settings-row-help';
  aiHelp.textContent = AI_FALLBACK_HELP;

  aiText.append(aiLabel, aiHelp);
  aiRow.append(aiToggle, aiText);

  // Status line + download CTA + error live OUTSIDE the <label> so a button
  // click can't toggle the checkbox.
  const aiStatus = document.createElement('div');
  aiStatus.className = 'settings-ai-status';
  aiStatus.id = 'settings-ai-status';
  aiStatus.setAttribute('role', 'status');
  aiStatus.textContent = 'Checking availability…';

  const aiDownloadBtn = document.createElement('button');
  aiDownloadBtn.type = 'button';
  aiDownloadBtn.id = 'settings-ai-download';
  aiDownloadBtn.className = 'settings-ai-download';
  aiDownloadBtn.textContent = 'Download model (~2 GB)';
  aiDownloadBtn.hidden = true;

  const aiError = document.createElement('div');
  aiError.className = 'settings-row-error';
  aiError.setAttribute('role', 'alert');
  aiError.hidden = true;

  body.append(aiRow, aiStatus, aiDownloadBtn, aiError);

  // Track the latest availability so post-flight handlers can restore the
  // correct disabled state without re-probing.
  let aiState: AiAvailability = 'unavailable';
  let aiLastPersisted = opts.settings.ai_fallback_enabled;
  let aiInFlight = false;

  function applyAvailability(state: AiAvailability): void {
    aiState = state;
    aiRow.removeAttribute('title');
    switch (state) {
      case 'available':
        aiToggle.disabled = false;
        aiDownloadBtn.hidden = true;
        aiStatus.textContent = 'Model ready — runs locally.';
        break;
      case 'downloadable':
        aiToggle.disabled = false;
        aiDownloadBtn.hidden = false;
        aiStatus.textContent = 'Model available to download.';
        break;
      case 'downloading':
        aiToggle.disabled = true;
        aiDownloadBtn.hidden = true;
        aiStatus.textContent = 'Downloading model…';
        break;
      case 'unavailable':
      default:
        aiToggle.disabled = true;
        aiDownloadBtn.hidden = true;
        aiStatus.textContent = 'Requires Chrome 138+ with built-in AI.';
        aiRow.title = 'Chrome 138+ with built-in AI required';
        break;
    }
  }

  void checkAvailability().then(applyAvailability);

  aiToggle.addEventListener('change', async () => {
    if (aiInFlight) return;
    const desired = aiToggle.checked;
    aiInFlight = true;
    aiToggle.disabled = true;
    aiError.hidden = true;
    try {
      const next = await opts.update({ ai_fallback_enabled: desired });
      aiLastPersisted = next.ai_fallback_enabled;
      aiToggle.checked = aiLastPersisted;
      // The toggle is the documented cache-invalidation trigger (D-AI-7) —
      // re-probe so a freshly-enabled user sees the download CTA if needed.
      applyAvailability(await checkAvailability());
    } catch (err) {
      aiToggle.checked = aiLastPersisted;
      aiError.hidden = false;
      aiError.textContent = 'Could not save: ' + (err instanceof Error ? err.message : String(err));
      applyAvailability(aiState); // restore disabled state from last known availability
    } finally {
      aiInFlight = false;
    }
  });

  aiDownloadBtn.addEventListener('click', async () => {
    aiDownloadBtn.disabled = true;
    aiError.hidden = true;
    aiStatus.textContent = 'Downloading… 0%';
    try {
      const state = await startModelDownload((fraction) => {
        aiStatus.textContent = `Downloading… ${Math.round(fraction * 100)}%`;
      });
      applyAvailability(state);
      if (state === 'available') {
        // Best-effort: record that the user accepted the download.
        try {
          await opts.update({ ai_model_downloaded: true });
        } catch {
          // Non-fatal — the model is downloaded regardless of this flag.
        }
      } else {
        aiError.hidden = false;
        aiError.textContent = 'Download did not complete. Try again.';
      }
    } finally {
      aiDownloadBtn.disabled = false;
    }
  });

  // === debug_logging (spec 016) — opt-in verbose console logging ===
  const debugRow = document.createElement('label');
  debugRow.className = 'settings-row';

  const debugToggle = document.createElement('input');
  debugToggle.type = 'checkbox';
  debugToggle.id = 'settings-debug-logging';
  debugToggle.checked = opts.settings.debug_logging ?? false;

  const debugText = document.createElement('div');
  debugText.className = 'settings-row-text';

  const debugLabel = document.createElement('div');
  debugLabel.className = 'settings-row-label';
  debugLabel.textContent = 'Verbose debug logging';

  const debugHelp = document.createElement('div');
  debugHelp.className = 'settings-row-help';
  debugHelp.textContent = DEBUG_LOGGING_HELP;

  debugText.append(debugLabel, debugHelp);
  debugRow.append(debugToggle, debugText);

  const debugError = document.createElement('div');
  debugError.className = 'settings-row-error';
  debugError.setAttribute('role', 'alert');
  debugError.hidden = true;

  let debugLastPersisted = opts.settings.debug_logging ?? false;
  let debugInFlight = false;
  debugToggle.addEventListener('change', async () => {
    if (debugInFlight) return;
    const desired = debugToggle.checked;
    debugInFlight = true;
    debugToggle.disabled = true;
    debugError.hidden = true;
    try {
      const next = await opts.update({ debug_logging: desired });
      debugLastPersisted = next.debug_logging ?? false;
      debugToggle.checked = debugLastPersisted;
    } catch (err) {
      debugToggle.checked = debugLastPersisted;
      debugError.hidden = false;
      debugError.textContent =
        'Could not save: ' + (err instanceof Error ? err.message : String(err));
    } finally {
      debugToggle.disabled = false;
      debugInFlight = false;
    }
  });

  body.append(debugRow, debugError);

  // === CareerSystems sync (binding) — full controls live here (spec 016 UI) ===
  if (opts.renderBindingInto) {
    const bindingSlot = document.createElement('div');
    bindingSlot.className = 'settings-binding-slot';
    body.appendChild(bindingSlot);
    opts.renderBindingInto(bindingSlot);
  }

  details.appendChild(body);
  root.appendChild(details);
}
