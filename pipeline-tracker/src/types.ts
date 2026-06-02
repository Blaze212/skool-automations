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
  // Spec 012 additions (Phase 2):
  BINDING: 'binding',
  // recovered_html is NOT a single key — it lives under per-id keys of the form
  //   `recovered_html_<history_id>`
  // so that the hot OutboxEntry payload stays small (~2 KB). D-rev-28. The
  // prefix is owned by the storage facade; callers use recoveredHtmlStore.*.
} as const;

// Spec 012 D5. ai_fallback_enabled + ai_model_downloaded are added by spec 013
// when it lands; capture_message_bodies + first_run_completed are owned here.
export interface Settings {
  ai_fallback_enabled: boolean;
  ai_model_downloaded: boolean;
  capture_message_bodies: boolean;
  first_run_completed: boolean;
}

// Spec 012 D-rev-8 two-phase binding handshake.
export type BindingStatus = 'pending' | 'confirmed';

export interface ExtensionBinding {
  token: string;
  bound_at: string; // ISO
  status: BindingStatus;
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
  /** LinkedIn job title captured at event time, if available. */
  title?: string;
  /** Captured message body — only present when capture_message_bodies was on. */
  message_text?: string;
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
