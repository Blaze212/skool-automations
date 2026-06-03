// Spec 090 / 015 A5.2 — content-script scrape confidence scoring.
//
// A cheap, AI-free heuristic that runs on every capture (inside sendEvent) to
// flag likely-degraded scrapes BEFORE they enter the outbox. The signal rides
// the wire event (→ tracker_events.scrape_confidence) so the server gets
// visibility into scraper degradation, and drives the OutboxEntry `needs_review`
// flag for the Part B side-panel review UI. For the MVP, low-confidence captures
// still sync — they are only flagged, never dropped.
//
// Kept in its own dependency-free module (no chrome.* imports) so it unit-tests
// as a pure function without standing up the full content-script environment.

import type { PipelineEvent, ScrapeConfidence } from '@cs/scraping-core';

// Toolbar/affordance labels that LinkedIn's DOM occasionally yields in place of
// a real person name when the scraper grabs the wrong node. Compared
// case-insensitively. These are letters-only, so they pass the character regex
// below — the junk set is what actually rejects them.
const NAME_JUNK = new Set(['connect', 'follow', 'message', '1st', '2nd', '3rd', 'you']);

// A plausible person name: starts with a letter (any script), followed by
// letters, spaces, hyphens, apostrophes, or periods. The `u` flag makes \p{L}
// match accented and non-Latin names. Digits or other symbols → reject (catches
// "1st"/"2nd" structurally; the junk set is the belt-and-suspenders).
const NAME_RE = /^\p{L}[\p{L} '.\-]*$/u;

// A real LinkedIn profile URL has an `/in/<slug>` segment with a slug of at
// least 3 chars before any query/fragment/trailing slash.
const PROFILE_URL_RE = /linkedin\.com\/in\/[^/?#]{3,}/;

const NAME_MIN = 2;
const NAME_MAX = 60;

function isPlausibleName(name: string): boolean {
  const trimmed = name.trim();
  return (
    trimmed.length >= NAME_MIN &&
    trimmed.length <= NAME_MAX &&
    !NAME_JUNK.has(trimmed.toLowerCase()) &&
    NAME_RE.test(trimmed)
  );
}

function isPlausibleProfileUrl(url: string): boolean {
  return PROFILE_URL_RE.test(url);
}

/**
 * Score a capture's scraper quality. `'high'` only when BOTH the name and the
 * LinkedIn URL look structurally sound; otherwise `'low'`.
 */
export function scoreCapture(
  event: Pick<PipelineEvent, 'name' | 'linkedin_url'>,
): ScrapeConfidence {
  const nameOk = isPlausibleName(event.name ?? '');
  const urlOk = isPlausibleProfileUrl(event.linkedin_url ?? '');
  return nameOk && urlOk ? 'high' : 'low';
}
