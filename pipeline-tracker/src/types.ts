// Canonical type definitions live in @cs/scraping-core (spec 011 phase 5).
// This file re-exports them for the extension-internal modules (background.ts,
// popup, content.ts) so their import paths don't have to change and so spec
// 012's publishable-build PR diff stays small.

export type {
  DebugPayload,
  EventType,
  ExtractionSource,
  PipelineEvent,
  ScrapeConfidence,
} from '@cs/scraping-core';

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
  /**
   * The account owner's first / last name, collected in the first-run modal.
   * Threaded into the on-device extraction prompt (ownerName) so the model can
   * tell the user's own messages from the contact's in a captured thread.
   * Optional for back-compat with settings persisted before this field existed;
   * absent ⇒ the prompt falls back to "the participant who is NOT the contact".
   */
  owner_first_name?: string;
  owner_last_name?: string;
}

// Spec 012 D-rev-8 two-phase binding handshake.
export type BindingStatus = 'pending' | 'confirmed';

export interface ExtensionBinding {
  token: string;
  bound_at: string; // ISO
  status: BindingStatus;
  // Email of the CareerSystems account this install is bound to. Supplied by
  // the app in its `bind-ack` (the page knows the logged-in user server-side)
  // and surfaced in the side panel's Connected state. Optional: older bindings
  // and any app build that doesn't send it leave this undefined, in which case
  // the UI falls back to a date-only "Connected on …" line.
  account_email?: string;
}

// `Severity` describes the badge state machine; it is extension-specific
// (popup colours + history rendering) so it stays here rather than moving
// into @cs/scraping-core.
export type Severity = 'ok' | 'partial' | 'error' | 'pending';

import type { EventType, PipelineEvent, ScrapeConfidence } from '@cs/scraping-core';

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
  /** Job title captured at event time, if available. */
  title?: string;
  /** Captured message body — only present when capture_message_bodies was on. */
  message_text?: string;
}

export interface OutboxEntry {
  history_id: string;
  event: PipelineEvent;
  enqueued_at: string;
  attempts: number;
  // Spec 090/015 A5.4 — scraper-quality signal from content's scoreCapture().
  // Mirrors event.scrape_confidence; `needs_review` is set when confidence is
  // 'low' so the Part B side-panel review UI can surface ⚠ items. Optional so
  // pre-090 persisted outbox entries still validate (treat absence as 'high').
  scrape_confidence?: ScrapeConfidence;
  needs_review?: boolean;
  // Spec 015 B2 — set true once the user has corrected/approved a flagged row in
  // the side-panel review UI. sync-pull skips `needs_review && !user_reviewed`
  // entries, so a low-confidence capture is held back from the app until the
  // user has had a chance to fix it (or explicitly approve it as-is).
  user_reviewed?: boolean;
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
// Spec 015 B2 — toolbar warning when low-confidence captures await review.
export const BADGE_TEXT_REVIEW = '⚠';
export const BADGE_COLOR_REVIEW = '#d97706';
