/**
 * Canonical shared types for @cs/scraping-core consumers.
 *
 * `PipelineEvent` is the wire payload the pipeline-tracker extension POSTs to
 * its webhook. Keeping the type here — rather than in pipeline-tracker/src —
 * lets future consumers (spec 012 publishable build, spec 013 AI fallback)
 * import the canonical shape without re-declaring it.
 *
 * pipeline-tracker/src/types.ts re-exports these for backward compatibility
 * with background.ts / popup / other internal modules.
 */

export type EventType = 'connection_request' | 'accepted_connection' | 'direct_message';

/**
 * Source of the extracted PipelineEvent fields. The selector chain produces
 * `'selectors'`; spec 013's on-device LanguageModel fallback populates
 * `'ai-recovered'` for rows where validate() flagged a gap and the model
 * repaired it. Spec 012 widens the union here (Phase 5) so the publishable
 * side panel and CSV export can render the badge without a type cast; spec
 * 013 wires the actual model invocation.
 */
export type ExtractionSource = 'selectors' | 'ai-recovered';

export interface DebugPayload {
  button_aria_label: string;
  button_text: string;
  container_html: string;
  page_url: string;
}

export interface PipelineEvent {
  api_key: string;
  event_type: EventType;
  date: string;
  name: string;
  title: string;
  linkedin_url: string;
  page_url: string;
  message_text: string;
  debug?: DebugPayload;
  // Spec 012 D5 — optional augmentations. Neither field is populated today;
  // content.ts does NOT copy extract()'s `source` onto the wire event in this
  // phase, so consumers MUST treat absence as equivalent to `'selectors'`
  // (the side-panel `sourceBadge()` does exactly that). Spec 013 wires
  // content.ts to start emitting `'ai-recovered'` for repaired rows and to
  // populate `recovered_html` via the per-id keyed store. `recovered_html`
  // is NEVER persisted inline on OutboxEntry — it lives in per-id keys
  // (`recovered_html_<history_id>`) and is attached to the wire-format
  // PipelineEvent only at sync-pull / CSV export time (D-rev-28).
  source?: ExtractionSource;
  recovered_html?: string;
}
