export const STORAGE_KEYS = {
  API_KEY: 'api_key',
  DEBUG_MODE: 'debug_mode',
  LAST_LOGGED_AT: 'last_logged_at',
  LAST_ERROR: 'last_error',
  UNREAD_COUNT: 'unread_count',
  HIGHEST_SEVERITY: 'highest_severity',
  LAST_STATUS: 'last_status',
  HISTORY: 'history',
} as const;

export type EventType = 'connection_request' | 'accepted_connection' | 'direct_message';

export type Severity = 'ok' | 'partial' | 'error';

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

export interface DebugPayload {
  button_aria_label: string;
  button_text: string;
  container_html: string;
  page_url: string;
}

export interface HistoryEntry {
  ts: string;
  status: Severity;
  event_type: EventType;
  name: string;
  page_url: string;
  message: string;
  warnings: string[];
  code?: string;
  http_status?: number;
}

export const HISTORY_CAP = 10;

export const BADGE_COLOR_OK = '#16a34a';
export const BADGE_COLOR_ERROR = '#dc2626';
export const BADGE_COLOR_PARTIAL = '#d97706';
export const BADGE_TEXT_COLOR = '#ffffff';

export const BADGE_TEXT_OK = '✓';
export const BADGE_TEXT_PARTIAL = '!';
export const BADGE_TEXT_ERROR = '✕';
