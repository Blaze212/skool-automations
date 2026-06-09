// Spec 016 — manual drag/paste capture card (the new input edge).
//
// A user drags a selected element from any web page into the side panel (or
// copies + pastes it). The dropped `text/html` / `text/plain` fragment is parsed
// by the site-agnostic heuristic plus a deterministic message/stage pass; the
// card is shown immediately (the AI is NEVER auto-run on a drop). The user can
// then click "Extract with AI" to refine name/title/url with the on-device model
// (injected as `aiExtract`; this module stays AI-agnostic). The user reviews the
// prefilled card, picks a Stage from the dropdown (AI suggests a default), and
// Saves, which enqueues exactly one wire PipelineEvent via the injected `onSave`.
//
// ── Capture state machine (E-3) ───────────────────────────────────────────────
//
//   drop / paste (heuristic + deterministic; AI NOT auto-run)
//   ┌──────────────┐
//   │    Empty     ├──────────────┐
//   └──────────────┘              ▼
//          ▲              ┌──────────────┐  "Extract with AI"  ┌───────────────────┐
//          │ save ok      │ Ready/Editing├────────────────────►│ Extracting(locked)│
//          │              │              │◄────────────────────┤                   │
//   ┌──────┴───────┐ save │              │  resolve / timeout  └───────────────────┘
//   │    Saving    │◄─────┤  new drop →  │      (heuristic stands)      │ new drop:
//   └──────────────┘      │  REPLACE     │                              │ IGNORED
//          │ save fails   │  (no confirm)│                              ▼ + toast
//          └──────────────┤              │                       (locked — stays
//        (inline error,   └──────────────┘                        Extracting)
//         card kept) ─────────►Ready
//
// Invariants:
//   • A new drop on an Empty / Ready / Saving card REPLACES it outright — drag-
//     and-replace is the fast path, so there is deliberately NO replace-confirm.
//     (`confirmReplace` is kept in the options for a caller that wants it, but is
//     intentionally not consulted here.) The ONE exception: while the model is
//     mid-extraction the card is locked, so a new drop is IGNORED with a toast
//     rather than racing the in-flight run.
//   • Card-lock release is in a `finally` so a thrown/rejected extraction still
//     unlocks (no silent stuck-card).
//   • Inputs are disabled while Extracting, so a late AI write can never clobber
//     a user edit; the generation counter invalidates any other in-flight async
//     step (page-url lookup, save) so a superseded one can't clobber a newer card.
//   • The Stage dropdown defaults to `suggested_event_type`, else
//     `connection_request` (visibly preselected, user-overridable).
//   • The dropped fragment is held in memory only (to support a manual re-run of
//     AI) and dropped on save/clear — it is NEVER persisted (D-016-3).

import type { EventType } from '../types.ts';
import type { ManualCaptureInput } from '../storage.ts';
import { type EditableEventFields, buildEditableFields } from './editable-fields.ts';
import { stripHtmlForCarry } from '@cs/scraping-core';
import {
  capFragment,
  classifyStage,
  extractHeuristic,
  extractOwnerMessage,
} from '../capture-heuristic.ts';

/** Result of the injected on-device AI extraction (Phase 2 wires extractContact). */
export interface AiExtractionResult {
  fields: EditableEventFields;
  /** AI's stage guess — validated against EventType by the extractor; may be null. */
  suggested_event_type: EventType | null;
}

/**
 * The on-device model timed out (distinct from a plain null "unavailable/failed").
 * The card keeps its heuristic + deterministic values but shows a warning so a
 * slow model degrades visibly instead of silently.
 */
export interface AiTimeout {
  timedOut: true;
}

/**
 * The selection was too large for the on-device model (the stripped HTML blew
 * the byte cap, or the model rejected the prompt as over-context). The AI parse
 * was skipped; the card keeps its heuristic + deterministic values and warns the
 * user to reduce the selection or enter the fields manually.
 */
export interface AiTooLarge {
  tooLarge: true;
}

export interface CaptureSectionOptions {
  /**
   * Persist the capture. MUST throw on failure (OutboxFullError / quota) — this
   * module catches it, shows an inline panel error, and KEEPS the card populated
   * (decision 2). On success the card resets to Empty.
   */
  onSave: (capture: ManualCaptureInput) => Promise<void>;
  /** Best-effort active-tab URL for page_url (D-016-1). '' when unavailable. */
  getPageUrl?: () => Promise<string>;
  /**
   * The account owner's display name (from settings). Used by the deterministic
   * message/stage pass to pick the most recent message the owner sent in a
   * thread. '' (or absent) disables that pass — the model still runs as fallback.
   */
  getOwnerName?: () => Promise<string> | string;
  /**
   * Phase 2 — on-device AI extraction. Resolves to repaired fields + a suggested
   * stage, or null when the model is unavailable / failed (heuristic stands).
   * MUST NOT throw (D-AI-1). Absent in Phase 1.
   */
  aiExtract?: (input: {
    html?: string;
    text?: string;
    candidate: EditableEventFields;
  }) => Promise<AiExtractionResult | AiTimeout | AiTooLarge | null>;
  /** Confirm replacing a populated card on a new drop. Default: window.confirm. */
  confirmReplace?: () => boolean;
  /**
   * Temporary debug hook (sample collection): called once per captured fragment
   * (every drop/paste), BEFORE the heuristic runs, with the exact fragment that
   * will feed the heuristic + LLM. The side panel uses it to log the LLM-bound
   * stripped content. No-op in production wiring if unset.
   */
  debugLogFragment?: (frag: { html?: string; text?: string }) => void;
}

export type CaptureState = 'empty' | 'extracting' | 'ready' | 'saving';

export interface CaptureSectionHandle {
  destroy: () => void;
  /** Test-only — observe the current state-machine state. */
  getState: () => CaptureState;
}

/** Stage dropdown labels → wire event_type (D-016-3). Order = pipeline order. */
const STAGE_OPTIONS: ReadonlyArray<{ label: string; value: EventType }> = [
  { label: 'Connect Sent', value: 'connection_request' },
  { label: 'Connection Accepted', value: 'accepted_connection' },
  { label: 'Sent DM', value: 'direct_message' },
  { label: 'Offered Value Add', value: 'offered_value_add' },
  { label: 'Sent Value Add', value: 'sent_value_add' },
  { label: 'Scheduled Call', value: 'scheduled_call' },
  { label: 'Follow Up', value: 'follow_up' },
  { label: 'No Action', value: 'no_action' },
];

const DEFAULT_EVENT_TYPE: EventType = 'connection_request';

interface Fragment {
  html?: string;
  text?: string;
}

export function renderCaptureSection(
  root: HTMLElement,
  opts: CaptureSectionOptions,
): CaptureSectionHandle {
  let state: CaptureState = 'empty';
  let fragment: Fragment | null = null;
  let pageUrl = '';
  let getEdits: (() => EditableEventFields) | null = null;
  // Deterministic message/stage for the current fragment (model-independent).
  // Recomputed on each drop; reused by a manual "Extract with AI" re-run so the
  // regex-found message and derived stage always win over the model's guesses.
  let det: { ownerMessage: string | null; stage: EventType } = {
    ownerMessage: null,
    stage: DEFAULT_EVENT_TYPE,
  };
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  // Bumped on every new fragment. Lets an in-flight async step (page-url lookup,
  // AI extraction, save) detect that a newer drop has superseded it and bail out
  // instead of clobbering the newer card. Supports the "new drop overwrites the
  // pending one" behavior below.
  let captureGeneration = 0;

  root.replaceChildren();

  const section = document.createElement('section');
  section.className = 'section capture-section';

  const header = document.createElement('div');
  header.className = 'section-header';
  const h2 = document.createElement('h2');
  h2.textContent = 'Capture';
  header.appendChild(h2);
  section.appendChild(header);

  // Focusable drop zone (E-2: paste is bound HERE, not document-level, so a
  // paste into the card's Message field stays native).
  const dropZone = document.createElement('div');
  dropZone.className = 'capture-dropzone';
  dropZone.tabIndex = 0;
  dropZone.setAttribute('role', 'button');
  dropZone.setAttribute(
    'aria-label',
    'Drop a selected element here, or click and paste, to capture a contact',
  );
  dropZone.textContent = 'Drag a selection here — or click and paste — to capture a contact.';
  section.appendChild(dropZone);

  const toast = document.createElement('div');
  toast.className = 'capture-toast';
  toast.hidden = true;
  section.appendChild(toast);

  // Card (hidden until a fragment lands).
  const card = document.createElement('div');
  card.className = 'capture-card';
  card.hidden = true;

  const extractingBanner = document.createElement('div');
  extractingBanner.className = 'capture-extracting';
  extractingBanner.textContent = 'Extracting…';
  extractingBanner.hidden = true;
  card.appendChild(extractingBanner);

  const fieldsHost = document.createElement('div');
  fieldsHost.className = 'capture-fields';
  card.appendChild(fieldsHost);

  // Stage dropdown.
  const stageRow = document.createElement('label');
  stageRow.className = 'review-field capture-stage';
  const stageLabel = document.createElement('span');
  stageLabel.className = 'review-field-label';
  stageLabel.textContent = 'Stage';
  stageRow.appendChild(stageLabel);
  const stageSelect = document.createElement('select');
  stageSelect.className = 'capture-stage-select';
  for (const opt of STAGE_OPTIONS) {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.label;
    stageSelect.appendChild(o);
  }
  stageRow.appendChild(stageSelect);
  card.appendChild(stageRow);

  // Paint the dropdown as a colored "bubble" matching the row badges
  // (connect = dark, accepted = green, dm = blue) for the selected stage.
  function paintStage(): void {
    for (const o of STAGE_OPTIONS) stageSelect.classList.remove(`stage-${o.value}`);
    stageSelect.classList.add(`stage-${stageSelect.value}`);
  }
  stageSelect.addEventListener('change', paintStage);

  // Non-blocking warning (e.g. the AI timed out): the card stays usable with its
  // heuristic + deterministic values, but the user is told the model didn't help.
  const warningEl = document.createElement('div');
  warningEl.className = 'capture-warning';
  warningEl.setAttribute('role', 'status');
  warningEl.hidden = true;
  card.appendChild(warningEl);

  const errorEl = document.createElement('div');
  errorEl.className = 'capture-error';
  errorEl.hidden = true;
  card.appendChild(errorEl);

  const actions = document.createElement('div');
  actions.className = 'capture-actions';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'capture-save-btn';
  saveBtn.textContent = 'Save to pipeline';
  actions.appendChild(saveBtn);

  const aiBtn = document.createElement('button');
  aiBtn.type = 'button';
  aiBtn.className = 'capture-ai-btn';
  aiBtn.textContent = 'Extract with AI';
  aiBtn.hidden = !opts.aiExtract;
  actions.appendChild(aiBtn);

  const discardBtn = document.createElement('button');
  discardBtn.type = 'button';
  discardBtn.className = 'capture-discard-btn';
  discardBtn.textContent = 'Discard';
  actions.appendChild(discardBtn);

  card.appendChild(actions);
  section.appendChild(card);
  root.appendChild(section);

  // --- helpers ---

  function showToast(message: string): void {
    toast.textContent = message;
    toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.hidden = true;
      toast.textContent = '';
    }, 2500);
  }

  function setControlsDisabled(disabled: boolean): void {
    for (const el of Array.from(card.querySelectorAll('input, textarea, select, button')) as (
      | HTMLInputElement
      | HTMLButtonElement
      | HTMLSelectElement
      | HTMLTextAreaElement
    )[]) {
      el.disabled = disabled;
    }
    // The AI button stays hidden if no extractor is wired.
    aiBtn.hidden = !opts.aiExtract;
  }

  function renderFields(fields: EditableEventFields, suggested: EventType | null): void {
    const built = buildEditableFields(fields);
    fieldsHost.replaceChildren(...built.rows);
    getEdits = built.getEdits;
    stageSelect.value = suggested ?? DEFAULT_EVENT_TYPE;
    paintStage();
  }

  function clearError(): void {
    errorEl.hidden = true;
    errorEl.textContent = '';
  }

  function showError(message: string): void {
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  function clearWarning(): void {
    warningEl.hidden = true;
    warningEl.textContent = '';
  }

  function showWarning(message: string): void {
    warningEl.textContent = message;
    warningEl.hidden = false;
  }

  function resetToEmpty(): void {
    state = 'empty';
    fragment = null;
    pageUrl = '';
    getEdits = null;
    card.hidden = true;
    extractingBanner.hidden = true;
    clearError();
    clearWarning();
    fieldsHost.replaceChildren();
  }

  function enterReady(fields: EditableEventFields, suggested: EventType | null): void {
    renderFields(fields, suggested);
    card.hidden = false;
    extractingBanner.hidden = true;
    state = 'ready';
    setControlsDisabled(false);
  }

  async function runAi(
    candidate: EditableEventFields,
    currentFragment: Fragment,
    gen: number,
  ): Promise<void> {
    if (!opts.aiExtract) {
      enterReady(candidate, det.stage);
      return;
    }
    // Show the (locked) heuristic values while the model runs so the user sees
    // something, then disable every control until it resolves.
    renderFields(candidate, det.stage);
    card.hidden = false;
    extractingBanner.hidden = false;
    clearWarning(); // a re-run clears any prior timeout warning
    state = 'extracting';
    setControlsDisabled(true);

    try {
      let result: AiExtractionResult | AiTimeout | AiTooLarge | null = null;
      try {
        result = await opts.aiExtract({
          html: currentFragment.html,
          text: currentFragment.text,
          candidate,
        });
      } catch (err) {
        // The extractor is contracted never to throw (D-AI-1), but guard anyway
        // so a rejection degrades to the heuristic instead of escaping unhandled.
        console.warn('[Pipeline Tracker capture] AI extraction threw — using heuristic:', err);
        result = null;
      }
      // A newer drop superseded this extraction — discard the stale result so it
      // can't clobber the newer card.
      if (gen !== captureGeneration) return;
      if (result && 'timedOut' in result) {
        // The model timed out: keep the heuristic + deterministic values (already
        // usable) but WARN the user instead of degrading silently.
        enterReady(candidate, det.stage);
        showWarning(
          'AI extraction timed out showing best-guess values. Review the fields before saving.',
        );
      } else if (result && 'tooLarge' in result) {
        // The selection was too big for the on-device model — the AI parse was
        // skipped. Keep the heuristic + deterministic values and tell the user.
        enterReady(candidate, det.stage);
        showWarning(
          'AI extraction skipped. Selection too large for on-device AI. Reduce the selection or enter the fields manually.',
        );
      } else if (result) {
        // The model owns name/title/url; the deterministic pass owns message_text
        // (when the regex found one) and the stage — both win over the model.
        enterReady(
          { ...result.fields, message_text: det.ownerMessage ?? result.fields.message_text },
          det.stage,
        );
      } else {
        // Unavailable / failed → heuristic + deterministic values stand (D-AI-1).
        enterReady(candidate, det.stage);
      }
    } finally {
      // Card-lock release MUST be in finally — a thrown extraction still unlocks.
      // Only if this is still the current capture (a newer drop owns the card now).
      if (gen === captureGeneration && state === 'extracting') enterReady(candidate, det.stage);
    }
  }

  async function onFragment(next: Fragment): Promise<void> {
    // A new drop on an Empty/Ready/Saving card REPLACES it outright — drag-and-
    // replace is the fast path, so there is deliberately no replace-confirm
    // (confirmReplace is intentionally not consulted). The ONE block: while the
    // model is mid-extraction the card is locked, so ignore the drop with a toast
    // rather than racing the in-flight run. The generation bump below invalidates
    // any other in-flight async step so it can't clobber this newer card.
    if (state === 'extracting') {
      showToast('Still extracting — wait for it to finish before capturing again.');
      return;
    }
    const gen = ++captureGeneration;

    // Log the exact fragment that will feed the heuristic + LLM, for EVERY drop,
    // before any early-return below — so even "nothing to capture" drops produce
    // a collectable sample.
    opts.debugLogFragment?.(next);

    clearError();
    clearWarning();
    fragment = next;
    pageUrl = opts.getPageUrl ? await safePageUrl() : '';
    if (gen !== captureGeneration) return; // superseded during the await

    // Run the heuristic on the STRIPPED subtree (same input the model gets) —
    // on the raw page DOM the parser drowns in nav/button/decoy nodes; on
    // the stripped subtree it reliably nails name/title/url. Fall back to the
    // raw fragment if the strip yields nothing (over-cap or no HTML).
    const strippedHtml = next.html ? stripHtmlForCarry(capFragment(next.html)) : '';
    const fields = extractHeuristic(strippedHtml ? { html: strippedHtml } : next);
    if (!fields.name && !fields.title && !fields.profile_url) {
      showToast('Nothing to capture from that selection.');
      resetToEmpty();
      return;
    }

    // Deterministic message + stage from the plain-text thread (model-independent:
    // runs even when the AI toggle is off / model unavailable). The regex pulls
    // the most recent message the OWNER sent; the stage is derived from it.
    const ownerName = opts.getOwnerName ? await safeOwnerName() : '';
    if (gen !== captureGeneration) return; // superseded during the await
    const convoText = next.text ?? '';
    const ownerMessage = extractOwnerMessage(convoText, ownerName);
    det = { ownerMessage, stage: classifyStage(convoText || strippedHtml || '', ownerMessage) };
    if (ownerMessage) fields.message_text = ownerMessage;

    // The heuristic + deterministic pass are right most of the time, so we NEVER
    // auto-run the model on a drop/paste — it just shows the parsed card. The
    // user can click "Extract with AI" to refine name/title/url when a capture
    // looks off (runAi still overrides message_text/stage with `det`).
    enterReady(fields, det.stage);
  }

  async function safePageUrl(): Promise<string> {
    try {
      return (await opts.getPageUrl?.()) ?? '';
    } catch {
      return '';
    }
  }

  async function safeOwnerName(): Promise<string> {
    try {
      return (await opts.getOwnerName?.()) ?? '';
    } catch {
      return '';
    }
  }

  function readFragmentFromDataTransfer(dt: DataTransfer | null): Fragment | null {
    if (!dt) return null;
    const html = dt.getData('text/html');
    const text = dt.getData('text/plain');
    if (!html && !text) return null;
    return { html: html || undefined, text: text || undefined };
  }

  // --- events ---

  function onDragOver(e: DragEvent): void {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    dropZone.classList.add('capture-dropzone-over');
  }
  function onDragLeave(): void {
    dropZone.classList.remove('capture-dropzone-over');
  }
  function onDrop(e: DragEvent): void {
    e.preventDefault();
    dropZone.classList.remove('capture-dropzone-over');
    const frag = readFragmentFromDataTransfer(e.dataTransfer);
    if (!frag) {
      showToast('Nothing to capture from that selection.');
      return;
    }
    void onFragment(frag);
  }
  function onPaste(e: ClipboardEvent): void {
    const frag = readFragmentFromDataTransfer(e.clipboardData);
    if (!frag) return;
    e.preventDefault();
    void onFragment(frag);
  }

  dropZone.addEventListener('dragover', onDragOver);
  dropZone.addEventListener('dragleave', onDragLeave);
  dropZone.addEventListener('drop', onDrop);
  dropZone.addEventListener('paste', onPaste);

  aiBtn.addEventListener('click', () => {
    if (state !== 'ready' || !fragment || !getEdits) return;
    void runAi(getEdits(), fragment, captureGeneration);
  });

  discardBtn.addEventListener('click', () => {
    if (state === 'extracting' || state === 'saving') return;
    resetToEmpty();
  });

  saveBtn.addEventListener('click', () => {
    if (state !== 'ready' || !getEdits) return;
    const edits = getEdits();
    const capture: ManualCaptureInput = {
      ...edits,
      event_type: stageSelect.value as EventType,
      page_url: pageUrl,
    };
    clearError();
    const gen = captureGeneration;
    state = 'saving';
    setControlsDisabled(true);
    void Promise.resolve(opts.onSave(capture))
      .then(() => {
        // A new drop arrived mid-save and now owns the card — don't wipe it.
        if (gen !== captureGeneration) return;
        resetToEmpty();
      })
      .catch((err: unknown) => {
        // A newer drop superseded this save — leave the newer card alone.
        if (gen !== captureGeneration) return;
        // Keep the card populated; surface an inline error (decision 2).
        state = 'ready';
        setControlsDisabled(false);
        const msg =
          err instanceof Error && /full|quota/i.test(err.message)
            ? "Couldn't save — sync or clear synced items, then retry."
            : `Couldn't save — ${err instanceof Error ? err.message : 'unknown error'}`;
        showError(msg);
      });
  });

  function destroy(): void {
    if (toastTimer) clearTimeout(toastTimer);
    dropZone.removeEventListener('dragover', onDragOver);
    dropZone.removeEventListener('dragleave', onDragLeave);
    dropZone.removeEventListener('drop', onDrop);
    dropZone.removeEventListener('paste', onPaste);
    root.replaceChildren();
  }

  return { destroy, getState: () => state };
}
