export const STORAGE_KEYS = {
  API_KEY: 'api_key',
  DEBUG_MODE: 'debug_mode',
  LAST_LOGGED_AT: 'last_logged_at',
  LAST_ERROR: 'last_error',
} as const;

export interface TrackerEvent {
  api_key: string;
  date: string;
  name: string;
  title: string;
  company: string;
  profile_url: string;
  page_url: string;
  message_type: 'Connection Request' | 'Direct Message';
  message_text: string;
  status: 'Sent';
  debug?: DebugPayload;
}

export interface DebugPayload {
  button_aria_label: string;
  button_text: string;
  container_html: string;
  page_url: string;
}
