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
}
