export const STORAGE_KEYS = {
  API_KEY: 'api_key',
  DEBUG_MODE: 'debug_mode',
  LAST_LOGGED_AT: 'last_logged_at',
  LAST_ERROR: 'last_error',
} as const;

export interface PipelineEvent {
  api_key: string;
  event_type: 'connection_request' | 'accepted_connection' | 'direct_message';
  date: string;
  name: string;
  title: string;
  linkedin_url: string;
  page_url: string;
  message_text: string;
  debug?: DebugPayload;
}

export interface DebugPayload {
  button_aria_label: string;
  button_text: string;
  container_html: string;
  page_url: string;
}
