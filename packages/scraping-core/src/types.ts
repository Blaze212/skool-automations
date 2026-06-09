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

export type EventType =
  | 'connection_request'
  | 'accepted_connection'
  | 'direct_message'
  | 'offered_value_add'
  | 'sent_value_add'
  | 'scheduled_call'
  | 'follow_up'
  | 'no_action';

/**
 * Source of the extracted PipelineEvent fields. The selector chain produces
 * `'selectors'`; spec 013's on-device LanguageModel fallback populates
 * `'ai-recovered'` for rows where validate() flagged a gap and the model
 * repaired it. Spec 012 widens the union here (Phase 5) so the publishable
 * side panel and CSV export can render the badge without a type cast; spec
 * 013 wires the actual model invocation.
 */
export type ExtractionSource = 'selectors' | 'ai-recovered';

/**
 * Cheap, AI-free scraper-quality signal computed in the content script
 * (spec 090 / 015 A5.2). `'high'` means both the name and profile URL passed
 * the structural heuristics; `'low'` flags a likely-degraded capture. Threaded
 * onto the wire `PipelineEvent` (→ `tracker_events.scrape_confidence`) so the
 * server has visibility into scraper degradation, and onto the OutboxEntry as
 * `needs_review` for the Part B side-panel review UI. Absent = treat as `'high'`
 * (pre-090 captures predate the signal).
 */
export type ScrapeConfidence = 'high' | 'low';

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
  /**
   * Site-agnostic profile/page URL (any https URL). Consumed by the
   * CareerSystems tracker-import as `tracker_events.profile_url`.
   */
  profile_url: string;
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
  // Spec 090/015 A5.3 — cheap scraper-quality signal stamped by the content
  // script's scoreCapture() at enqueue time. Maps to the tracker_events
  // `scrape_confidence` column. Absent = treat as 'high' (pre-090 captures).
  scrape_confidence?: ScrapeConfidence;
}
