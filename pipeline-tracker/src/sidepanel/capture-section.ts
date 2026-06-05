// Spec 016 — manual drag/paste capture card (the new input edge).
//
// A user drags a selected element from any web page into the side panel (or
// copies + pastes it). The dropped `text/html` / `text/plain` fragment is parsed
// by the site-agnostic heuristic and — when the heuristic is low-confidence or
// the user asks — repaired by the on-device model (injected as `aiExtract`; this
// module stays AI-agnostic). The user reviews the prefilled card, picks a Stage
// from the dropdown (AI suggests a default), and Saves, which enqueues exactly
// one wire PipelineEvent via the injected `onSave`.
//
// ── Capture state machine (E-3) ───────────────────────────────────────────────
//
//      drop / paste                 low-confidence (or "Extract with AI")
//   ┌──────────────┐   fragment   ┌───────────────────┐   resolve / timeout
//   │    Empty     ├─────────────►│ Extracting(locked)├─────────────────┐
//   └──────────────┘              └───────────────────┘                 │
//          ▲                           ▲  │ (new drop ignored + toast)   ▼
//          │ save ok                   │  └──────────────────────►┌──────────────┐
//          │                           │   high-confidence (no AI) │ Ready/Editing│
//   ┌──────┴───────┐   save           │◄──────────────────────────┤              │
//   │    Saving    │◄─────────────────┼───────────────────────────┤  new drop +  │
//   └──────────────┘   save fails ───►│  Ready (inline error,      │  unsaved →   │
//          │           (card kept)    │  card retained)            │  confirm     │
//          └─────────────────────────────────────────────────────►└──────────────┘
//
// Invariants:
//   • Card-lock release is in a `finally` so a thrown/rejected extraction still
//     unlocks (no silent stuck-card).
//   • Inputs are disabled while Extracting, so a late AI write can never clobber
//     a user edit.
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
  extractHeuristic,
  heuristicConfidence,
  looksLikeConversation,
} from '../capture-heuristic.ts';

/** Result of the injected on-device AI extraction (Phase 2 wires extractContact). */
export interface AiExtractionResult {
  fields: EditableEventFields;
  /** AI's stage guess — validated against EventType by the extractor; may be null. */
  suggested_event_type: EventType | null;
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
   * Phase 2 — on-device AI extraction. Resolves to repaired fields + a suggested
   * stage, or null when the model is unavailable / failed (heuristic stands).
   * MUST NOT throw (D-AI-1). Absent in Phase 1.
   */
  aiExtract?: (input: {
    html?: string;
    text?: string;
    candidate: EditableEventFields;
  }) => Promise<AiExtractionResult | null>;
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

/** Stage dropdown labels → wire event_type (D-016-3). Order = display order. */
const STAGE_OPTIONS: ReadonlyArray<{ label: string; value: EventType }> = [
  { label: 'Sent connection request', value: 'connection_request' },
  { label: 'Connection accepted', value: 'accepted_connection' },
  { label: 'Sent / received a message', value: 'direct_message' },
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

  function resetToEmpty(): void {
    state = 'empty';
    fragment = null;
    pageUrl = '';
    getEdits = null;
    card.hidden = true;
    extractingBanner.hidden = true;
    clearError();
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
      enterReady(candidate, null);
      return;
    }
    // Show the (locked) heuristic values while the model runs so the user sees
    // something, then disable every control until it resolves.
    renderFields(candidate, null);
    card.hidden = false;
    extractingBanner.hidden = false;
    state = 'extracting';
    setControlsDisabled(true);

    try {
      let result: AiExtractionResult | null = null;
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
      if (result) {
        enterReady(result.fields, result.suggested_event_type);
      } else {
        // Unavailable / failed → heuristic values stand (D-AI-1).
        enterReady(candidate, null);
      }
    } finally {
      // Card-lock release MUST be in finally — a thrown extraction still unlocks.
      // Only if this is still the current capture (a newer drop owns the card now).
      if (gen === captureGeneration && state === 'extracting') enterReady(candidate, null);
    }
  }

  async function onFragment(next: Fragment): Promise<void> {
    // TEMPORARY (sample collection): a new drop always overwrites whatever is
    // pending — no "still extracting" block, no replace-confirm. The generation
    // bump invalidates any in-flight extraction/save so it can't clobber this
    // newer card. (Restore the state guards + confirmReplace to revert.)
    const gen = ++captureGeneration;

    // Log the exact fragment that will feed the heuristic + LLM, for EVERY drop,
    // before any early-return below — so even "nothing to capture" drops produce
    // a collectable sample.
    opts.debugLogFragment?.(next);

    clearError();
    fragment = next;
    pageUrl = opts.getPageUrl ? await safePageUrl() : '';
    if (gen !== captureGeneration) return; // superseded during the await

    // Run the heuristic on the STRIPPED subtree (same input the model gets) —
    // on the raw LinkedIn DOM the parser drowns in nav/button/decoy nodes; on
    // the stripped subtree it reliably nails name/title/url. Fall back to the
    // raw fragment if the strip yields nothing (over-cap or no HTML).
    const strippedHtml = next.html ? stripHtmlForCarry(capFragment(next.html)) : '';
    const fields = extractHeuristic(strippedHtml ? { html: strippedHtml } : next);
    if (!fields.name && !fields.title && !fields.linkedin_url) {
      showToast('Nothing to capture from that selection.');
      resetToEmpty();
      return;
    }

    // The heuristic owns name/title/url. We still need the model for a message
    // thread (message_text + stage), so run it when the heuristic is low-
    // confidence OR the fragment looks like a conversation.
    const confidence = heuristicConfidence(fields);
    const conversation = looksLikeConversation(strippedHtml || next.html || next.text || '');
    if (opts.aiExtract && (confidence === 'low' || conversation)) {
      await runAi(fields, next, gen);
    } else {
      enterReady(fields, null);
    }
  }

  async function safePageUrl(): Promise<string> {
    try {
      return (await opts.getPageUrl?.()) ?? '';
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
