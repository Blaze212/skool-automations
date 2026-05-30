/**
 * Post-extraction validation for PipelineEvents.
 *
 * Each card class makes best-effort extraction from the DOM. After extraction
 * we run `validate()` to catch two failure modes the cards can't always
 * prevent on their own:
 *
 *   1. **Required-field gaps** — a card fired but couldn't recover one of the
 *      load-bearing fields (`name`, `linkedin_url`). Title is also required
 *      for connection_request / accepted_connection but warned-only for DMs
 *      (LinkedIn's chat overlay routinely omits a headline).
 *
 *   2. **Noise patterns** — a card returned a value that *looks* extracted
 *      but is actually UI chrome the selectors couldn't fully strip:
 *        - "Premium" badge text leaking into name
 *        - "1st" / "2nd" / "3rd" connection-degree markers
 *        - "Mutual connection" / "23 mutual connections" rollups
 *        - "Open to work" status text
 *        - "Follower(s)" counts
 *
 * The result drives both the badge severity (background.ts) and, in spec 013,
 * the AI-fallback decision (only retry when `dirty === true`).
 *
 * Validation does NOT mutate the event. The orchestrator (`extract.ts`)
 * decides whether to attempt recovery; callers downstream of that can rely on
 * `dirty === false` meaning "selectors got everything cleanly".
 */

import type { PipelineEvent } from './types.js';

/**
 * Why a field tripped validation. Codes are stable strings so downstream
 * (background.ts severity logic, spec 013 AI prompt selection) can switch on
 * them without re-parsing English.
 */
export type ValidationGapCode =
  | 'missing-required'
  | 'noise-degree-marker'
  | 'noise-mutual-connection'
  | 'noise-premium-badge'
  | 'noise-open-to-work'
  | 'noise-follower-count';

export interface ValidationGap {
  /** The PipelineEvent field that failed. */
  field: 'name' | 'title' | 'linkedin_url';
  /** Stable code identifying the rule that tripped. */
  code: ValidationGapCode;
  /** Human-readable explanation, suitable for logs/popup history. */
  message: string;
}

export interface ValidationResult {
  /** True when at least one gap was found. */
  dirty: boolean;
  /** Every rule violation, in stable order (required-first, then noise). */
  gaps: ValidationGap[];
}

// =============================================================================
// Noise pattern catalogue
// =============================================================================
// Patterns are exported for tests so a new pattern only needs to be added in
// one place. Each has a single code (so downstream switch-on-code stays sane).

/** Connection-degree markers: "1st", "2nd", "3rd", with optional surrounding "·". */
export const DEGREE_MARKER_RE = /(^|\s|·)(1st|2nd|3rd)(\s|·|$)/i;

/** "23 mutual connections", "Mutual connection", etc. */
export const MUTUAL_CONNECTION_RE = /\bmutual\s+connection(s)?\b/i;

/** "Premium" membership badge text. */
export const PREMIUM_BADGE_RE = /\bpremium\b/i;

/** "Open to work" status overlay text. */
export const OPEN_TO_WORK_RE = /\bopen\s+to\s+work\b/i;

/** "1234 followers" / "Follower" counts. */
export const FOLLOWER_COUNT_RE = /\bfollower(s)?\b/i;

interface NoiseRule {
  pattern: RegExp;
  code: ValidationGapCode;
  label: string;
}

const NOISE_RULES: readonly NoiseRule[] = [
  { pattern: DEGREE_MARKER_RE, code: 'noise-degree-marker', label: 'connection-degree marker' },
  {
    pattern: MUTUAL_CONNECTION_RE,
    code: 'noise-mutual-connection',
    label: 'mutual-connection rollup',
  },
  { pattern: PREMIUM_BADGE_RE, code: 'noise-premium-badge', label: 'Premium badge text' },
  { pattern: OPEN_TO_WORK_RE, code: 'noise-open-to-work', label: 'Open-to-work overlay text' },
  { pattern: FOLLOWER_COUNT_RE, code: 'noise-follower-count', label: 'follower count' },
] as const;

// =============================================================================
// Required-field rules
// =============================================================================

function isBlank(s: string | null | undefined): boolean {
  return !s || !s.trim();
}

/**
 * Title is structurally optional for direct_message events: LinkedIn's chat
 * overlay frequently has no headline available (the profile card hasn't
 * loaded, or the recipient sits in a thread-only context). Flagging it as a
 * gap for DMs would generate constant warning noise; the cards still emit ''
 * and downstream consumers just render an empty title cell.
 */
function isTitleRequired(eventType: PipelineEvent['event_type']): boolean {
  return eventType !== 'direct_message';
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Run all validation rules over a freshly-extracted PipelineEvent. Pure: no
 * side effects, no DOM access, no chrome.* dependencies — safe to import from
 * the extension service worker, the side panel, or a node test.
 */
export function validate(event: PipelineEvent): ValidationResult {
  const gaps: ValidationGap[] = [];

  // Required-field rules. Run these first so the resulting gap array is
  // ordered "structural problems before cosmetic noise".
  if (isBlank(event.name)) {
    gaps.push({
      field: 'name',
      code: 'missing-required',
      message: 'name is required but extraction returned empty',
    });
  }
  if (isBlank(event.linkedin_url)) {
    gaps.push({
      field: 'linkedin_url',
      code: 'missing-required',
      message: 'linkedin_url is required but extraction returned empty',
    });
  }
  if (isTitleRequired(event.event_type) && isBlank(event.title)) {
    gaps.push({
      field: 'title',
      code: 'missing-required',
      message: `title is required for ${event.event_type} but extraction returned empty`,
    });
  }

  // Noise rules — run over name and title (the two human-language fields).
  // linkedin_url is a normalized URL; if the URL parser produced something it
  // is structurally valid by construction, so we don't pattern-match it.
  for (const rule of NOISE_RULES) {
    if (event.name && rule.pattern.test(event.name)) {
      gaps.push({
        field: 'name',
        code: rule.code,
        message: `name contains ${rule.label}: "${event.name}"`,
      });
    }
    if (event.title && rule.pattern.test(event.title)) {
      gaps.push({
        field: 'title',
        code: rule.code,
        message: `title contains ${rule.label}: "${event.title}"`,
      });
    }
  }

  return { dirty: gaps.length > 0, gaps };
}
