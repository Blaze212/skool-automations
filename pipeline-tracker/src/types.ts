// Canonical type definitions live in @cs/scraping-core (spec 011 phase 5).
// This file re-exports them for the extension-internal modules (background.ts,
// popup, content.ts) so their import paths don't have to change and so spec
// 012's publishable-build PR diff stays small.

export type { DebugPayload, EventType, ExtractionSource, PipelineEvent } from '@cs/scraping-core';

export const STORAGE_KEYS = {
  API_KEY: 'api_key',
  DEBUG_MODE: 'debug_mode',
  LAST_LOGGED_AT: 'last_logged_at',
  LAST_ERROR: 'last_error',
  UNREAD_COUNT: 'unread_count',
  HIGHEST_SEVERITY: 'highest_severity',
  LAST_STATUS: 'last_status',
  HISTORY: 'history',
  OUTBOX: 'outbox',
  // Spec 012 additions (Phase 1):
  SETTINGS: 'settings',
  LAST_SYNCED_AT: 'last_synced_at',
} as const;

// Spec 012 D5. ai_fallback_enabled + ai_model_downloaded are added by spec 013
// when it lands; capture_message_bodies + first_run_completed are owned here.
export interface Settings {
  ai_fallback_enabled: boolean;
  ai_model_downloaded: boolean;
  capture_message_bodies: boolean;
  first_run_completed: boolean;
}

// `Severity` describes the badge state machine; it is extension-specific
// (popup colours + history rendering) so it stays here rather than moving
// into @cs/scraping-core.
export type Severity = 'ok' | 'partial' | 'error' | 'pending';

import type { EventType, PipelineEvent } from '@cs/scraping-core';

export interface HistoryEntry {
  id: string;
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

export interface OutboxEntry {
  history_id: string;
  event: PipelineEvent;
  enqueued_at: string;
  attempts: number;
}

export const HISTORY_CAP = 10;
export const OUTBOX_CAP = 50;
export const OUTBOX_MAX_ATTEMPTS = 3;
export const OUTBOX_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export const BADGE_COLOR_OK = '#16a34a';
export const BADGE_COLOR_ERROR = '#dc2626';
export const BADGE_COLOR_PARTIAL = '#d97706';
export const BADGE_COLOR_PENDING = '#9333ea';
export const BADGE_TEXT_COLOR = '#ffffff';

export const BADGE_TEXT_OK = '✓';
export const BADGE_TEXT_PARTIAL = '!';
export const BADGE_TEXT_ERROR = '✕';
