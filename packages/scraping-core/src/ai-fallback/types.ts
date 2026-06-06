/**
 * Shared types for the on-device AI fallback (spec 013).
 *
 * The `LanguageModel` global is Chrome's built-in Prompt API surface (Chrome
 * 138+ for extensions). It is NOT in lib.dom yet, so we declare the minimal
 * slice we use. See the chrome-extension-mv3 skill (`chrome-prompt-api`) for
 * verified signatures.
 */

import type { EventType } from '../types.js';

export type AiAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

/** BCP-47 output language passed to every LanguageModel request. The extension
 * extracts English-first contact fields, so 'en' is correct. Must be one of
 * Chrome's currently-supported output codes: de, en, es, fr, ja. */
export const AI_OUTPUT_LANGUAGE = 'en';

export interface DownloadProgressEvent {
  /** Fraction 0–1 of the model download completed. */
  readonly loaded: number;
}

export interface CreateMonitor {
  addEventListener(
    type: 'downloadprogress',
    listener: (event: DownloadProgressEvent) => void,
  ): void;
}

/** Declares an expected input/output modality + its languages. Chrome uses the
 * output language to attest output safety and pick the best decoding path. */
export interface LanguageModelExpectation {
  type: 'text' | 'image' | 'audio';
  languages?: string[];
}

/** Core options shared by `availability()` and `create()`. Shipped Chrome
 * (unlike the W3C proposal, which only documents `expectedOutputs`) reads a
 * top-level `outputLanguage` to attest output safety, and emits the runtime
 * warning "No output language was specified in a LanguageModel API request"
 * on ANY request — including `availability()` — that omits it. We pass it on
 * every call. Supported codes today: de, en, es, fr, ja. */
export interface LanguageModelCoreOptions {
  /** BCP-47 output language code (e.g. 'en'). Silences the "No output language
   * was specified" warning and improves output quality + safety attestation. */
  outputLanguage?: string;
  /** Expected input modalities/languages. */
  expectedInputs?: LanguageModelExpectation[];
  /** Expected output modalities/languages (spec-proposal capability hint;
   * does NOT itself suppress the warning in shipped Chrome — see outputLanguage). */
  expectedOutputs?: LanguageModelExpectation[];
}

export interface LanguageModelCreateOptions extends LanguageModelCoreOptions {
  /** Aborts the in-flight create() and tears the session down if it fires. */
  signal?: AbortSignal;
  /** Hook for download-progress events when availability is 'downloadable'. */
  monitor?: (monitor: CreateMonitor) => void;
}

export interface LanguageModelPromptOptions {
  signal?: AbortSignal;
  /** JSON Schema (or RegExp) constraining the output. Chrome 137+. */
  responseConstraint?: object;
}

export interface LanguageModelSession {
  prompt(input: string, options?: LanguageModelPromptOptions): Promise<string>;
  destroy?(): void;
}

export interface LanguageModelStatic {
  availability(options?: LanguageModelCoreOptions): Promise<AiAvailability>;
  create(options?: LanguageModelCreateOptions): Promise<LanguageModelSession>;
}

declare global {
  // eslint-disable-next-line no-var
  var LanguageModel: LanguageModelStatic | undefined;
}

/**
 * Spec 016 — the four contact fields the on-device extractor fills. Shares the
 * wire-field name `linkedin_url` (kept for tracker-import back-compat), but the
 * value may be any-site URL — the model is no longer LinkedIn-anchored.
 */
export interface ContactFields {
  name: string;
  title: string;
  linkedin_url: string;
  message_text: string;
}

/** Input to extractContact() — trimmed HTML plus the heuristic candidate. */
export interface ExtractContactInput {
  /** Stripped subtree, ≤ RECOVERED_HTML_CAP_BYTES. Produced by stripHtmlForCarry. */
  trimmedHtml: string;
  /** Heuristic output. Treated as hints, reconciled against AI output. */
  candidate: ContactFields;
  /** The page the fragment was selected from (best-effort; '' is fine). */
  pageUrl: string;
  /**
   * The account owner's display name (the person doing the capturing). Used to
   * identify which messages in a thread are "ours" so message_text picks the
   * most recent message WE sent. Optional — when absent the prompt falls back to
   * "the participant who is NOT the primary contact". '' is fine.
   */
  ownerName?: string;
}

export interface ExtractContactResult {
  /** The candidate fields with AI-extracted values merged in. */
  fields: ContactFields;
  /** AI's stage guess, validated against EventType and coerced to null if unknown. */
  suggested_event_type: EventType | null;
}

/**
 * extractContact() resolves to this when the model failed SPECIFICALLY because
 * it timed out (the create()/prompt() AbortSignal fired). It is distinct from the
 * `null` returned for every other failure (unavailable, disabled, parse error,
 * refusal, over-quota) so the UI can show a "took too long" warning instead of
 * silently degrading to the heuristic. D-AI-1 still holds: extractContact never
 * throws — a timeout is a resolved value, not a rejection.
 */
export interface ExtractContactTimeout {
  timedOut: true;
}

/**
 * extractContact() resolves to this when the model rejected the prompt because
 * the input exceeded its context window (a QuotaExceededError — "input is too
 * large"). Distinct from `null` so the UI can tell the user the selection was
 * too big and the AI parse was skipped, rather than degrading silently. D-AI-1
 * still holds: this is a resolved value, not a thrown error.
 */
export interface ExtractContactTooLarge {
  tooLarge: true;
}
