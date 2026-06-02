/**
 * Shared types for the on-device AI fallback (spec 013).
 *
 * The `LanguageModel` global is Chrome's built-in Prompt API surface (Chrome
 * 138+ for extensions). It is NOT in lib.dom yet, so we declare the minimal
 * slice we use. See the chrome-extension-mv3 skill (`chrome-prompt-api`) for
 * verified signatures.
 */

import type { PipelineEvent } from '../types.js';
import type { ValidationGap } from '../validate.js';

export type AiAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

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

export interface LanguageModelCreateOptions {
  /** Aborts the in-flight create() and tears the session down if it fires. */
  signal?: AbortSignal;
  /** Hook for download-progress events when availability is 'downloadable'. */
  monitor?: (monitor: CreateMonitor) => void;
  /** Expected input modalities/languages. */
  expectedInputs?: LanguageModelExpectation[];
  /** Expected output modalities/languages. Declaring the output language
   * silences Chrome's "No output language was specified" warning and improves
   * output quality + safety attestation. */
  expectedOutputs?: LanguageModelExpectation[];
}

export interface LanguageModelPromptOptions {
  signal?: AbortSignal;
  /** JSON Schema (or RegExp) constraining the output. Chrome 137+. */
  responseConstraint?: object;
}

/**
 * The Prompt API's token-accounting surface has been renamed twice. We support
 * all three generations defensively (verified against the Chrome docs +
 * webmachinelearning/prompt-api explainer, 2026-06):
 *
 *   Total budget       Used so far     Measure a prompt
 *   ----------------   -------------   ---------------------
 *   contextWindow      contextUsage    measureContextUsage()   ← current (Chrome ~141+, incl. 148)
 *   inputQuota         inputUsage      measureInputUsage()      ← interim
 *   maxTokens          tokensSoFar     countPromptTokens()      ← legacy
 *
 * All optional — guard each with `typeof` before use.
 */
export interface LanguageModelSession {
  prompt(input: string, options?: LanguageModelPromptOptions): Promise<string>;

  measureContextUsage?(input: string, options?: { signal?: AbortSignal }): Promise<number>;
  measureInputUsage?(input: string, options?: { signal?: AbortSignal }): Promise<number>;
  countPromptTokens?(input: string, options?: { signal?: AbortSignal }): Promise<number>;

  readonly contextWindow?: number;
  readonly inputQuota?: number;
  readonly maxTokens?: number;

  readonly contextUsage?: number;
  readonly inputUsage?: number;
  readonly tokensSoFar?: number;

  destroy?(): void;
}

export interface LanguageModelStatic {
  availability(): Promise<AiAvailability>;
  create(options?: LanguageModelCreateOptions): Promise<LanguageModelSession>;
}

declare global {
  // eslint-disable-next-line no-var
  var LanguageModel: LanguageModelStatic | undefined;
}

/** Input to recover() — already-trimmed HTML plus the scraper's candidate. */
export interface RecoverInput {
  /** Stripped subtree, ≤ RECOVERED_HTML_CAP_BYTES. Produced by stripHtmlForCarry. */
  trimmedHtml: string;
  /** Current scraper output. Treated as hints, reconciled against AI output. */
  candidate: PipelineEvent;
  /** Which fields validate() flagged. */
  gaps: ValidationGap[];
  pageUrl: string;
}

export interface RecoverResult {
  /** The candidate event with AI-recovered fields merged in. */
  filledEvent: PipelineEvent;
  /** Empty on clean success; populated on partial recovery. */
  warnings: string[];
}
