// Spec 016 D-016-2 — site-agnostic heuristic fast-path for manual capture.
//
// Turns a dropped/pasted fragment (text/html or text/plain) into best-effort
// { name, title, linkedin_url, message_text } with NO AI, instantly, and scores
// its confidence so the capture flow knows whether to fall back to the on-device
// model. Dependency-free (no chrome.*) so it unit-tests as a pure function.
//
// This is the single confidence function in the manual-capture build: spec 016
// eng-review E-4 deletes score-capture.ts (its scoreCapture() linkedin.com/in/
// URL gate would force every non-LinkedIn capture to 'low'). heuristicConfidence
// re-uses the same site-agnostic NAME_RE / junk set heuristics, but gates the URL
// on "any non-empty https: URL" instead of a LinkedIn profile path.

import {
  DEGREE_MARKER_RE,
  MUTUAL_CONNECTION_RE,
  PREMIUM_BADGE_RE,
  OPEN_TO_WORK_RE,
  FOLLOWER_COUNT_RE,
} from '@cs/scraping-core';
import type { EventType } from '@cs/scraping-core';
import type { EditableEventFields } from './sidepanel/editable-fields.ts';
import type { ScrapeConfidence } from './types.ts';

// Spec 016 E-10 — hard cap on the raw dropped fragment BEFORE DOMParser, so a
// pathological whole-page selection can't jank the panel. The pipeline is:
//   raw ≤ FRAGMENT_MAX_BYTES → DOMParser → stripHtmlForCarry ≤ 16KB → AI.
//
// This is ONLY a parser-jank guard against multi-MB selections — it is NOT the
// content budget. That budget is stripHtmlForCarry's 16KB post-strip cap, which
// applies to the LEAN (attribute-stripped) HTML. Capping the RAW HTML must
// therefore be generous: LinkedIn's message-thread DOM is extremely attribute-
// dense (every bubble carries hundreds of class/data-*/aria-* attributes — KBs
// per bubble), so a small raw cap truncates a normal thread mid-bubble and the
// model never sees the most recent messages. After stripping, that same thread
// is only a few KB. Keep this high enough that real threads pass through intact
// and only genuinely pathological (multi-MB) whole-page dumps get truncated.
export const FRAGMENT_MAX_BYTES = 4 * 1024 * 1024;

// Toolbar/affordance labels and pronoun chips that the DOM occasionally yields
// in place of a real person name. Compared case-insensitively. (Site-agnostic —
// inherited from spec 090's score-capture heuristics.)
const NAME_JUNK = new Set([
  'connect',
  'follow',
  'message',
  '1st',
  '2nd',
  '3rd',
  'you',
  'he',
  'him',
  'she',
  'her',
  'they',
  'them',
  'he/him',
  'she/her',
  'they/them',
]);

// A plausible person name: starts with a letter (any script), followed by
// letters, spaces, hyphens, apostrophes, or periods. The `u` flag makes \p{L}
// match accented and non-Latin names. Digits or other symbols → reject.
const NAME_RE = /^\p{L}[\p{L} '.\-]*$/u;

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

function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

// UI-junk lines the title scan must skip — connection-degree markers, pronoun
// chips, mutual-connection rollups, follower/connection counts, "Contact info",
// and message-thread chrome (timestamps, "View X's profile"). Reuses the shared
// noise regexes from @cs/scraping-core; the rest are local to title selection.
const DEGREE_CONNECTION_RE = /\bdegree connection\b/i;
const CONNECTION_COUNT_RE = /^[·•\s]*[\d,.]+\s*\+?\s*connections?$/i;
const BULLET_ONLY_RE = /^[·•∙\s]+$/;
const CONTACT_INFO_RE = /^contact info$/i;
const PRONOUN_RE = /^\(?\s*(he|him|she|her|they|them)(\s*\/\s*(he|him|she|her|they|them))?\s*\)?$/i;
const THREAD_CHROME_RE =
  /(sent the following messages?|view .+? profile|^today$|^yesterday$|^(mon|tues|wednes|thurs|fri|satur|sun)day$|^\d{1,2}:\d{2}\s*(am|pm)$)/i;

/** True when a text line is UI chrome rather than a real headline/role line. */
function isJunkLine(line: string): boolean {
  const s = line.trim();
  if (!s) return true;
  if (NAME_JUNK.has(s.toLowerCase())) return true;
  return (
    DEGREE_MARKER_RE.test(s) ||
    MUTUAL_CONNECTION_RE.test(s) ||
    PREMIUM_BADGE_RE.test(s) ||
    OPEN_TO_WORK_RE.test(s) ||
    FOLLOWER_COUNT_RE.test(s) ||
    DEGREE_CONNECTION_RE.test(s) ||
    CONNECTION_COUNT_RE.test(s) ||
    BULLET_ONLY_RE.test(s) ||
    CONTACT_INFO_RE.test(s) ||
    PRONOUN_RE.test(s) ||
    THREAD_CHROME_RE.test(s)
  );
}

/**
 * Canonicalize a profile URL by dropping tracking. LinkedIn keeps identity in
 * the path (the `?lipi`/`?trk` params are pure tracking); for other hosts strip
 * only known tracking params so we don't break identity-bearing query strings.
 */
function cleanUrl(url: string): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (/(^|\.)linkedin\.com$/i.test(u.hostname)) return u.origin + u.pathname;
    const TRACKING = /^(lipi|trk|utm_|original_referer|refId|miniProfileUrn)/i;
    const drop: string[] = [];
    u.searchParams.forEach((_v, k) => {
      if (TRACKING.test(k)) drop.push(k);
    });
    for (const k of drop) u.searchParams.delete(k);
    u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * True when the fragment looks like a message thread (so the AI is still worth
 * running for message_text + stage even when the heuristic nailed name/url).
 * "X sent the following message" is LinkedIn's per-bubble attribution line and
 * is present in every conversation capture but not in profile/search captures.
 */
const CONVERSATION_RE = /\bsent the following messages?\b/i;
export function looksLikeConversation(html: string): boolean {
  return CONVERSATION_RE.test(html ?? '');
}

// --- Deterministic owner-message + stage extraction (spec 016 follow-up) ---
//
// LinkedIn renders a message thread as a flat, regular structure in the
// text/plain a drag/paste carries:
//
//   <date sep, e.g. "May 26" | "Monday" | "Today">
//   <Sender> sent the following message(s) at <time>   ← group header (optional)
//   View <First>'s profile<Sender>                      ← bubble chrome
//   <Sender>   <time>                                   ← bubble header (author)
//   <message body line(s)>
//
// A small on-device model is unreliable at "find the LAST message *I* sent"
// reading bottom-up through this noise; a deterministic pass is exact. It is
// LinkedIn-text-format-specific, so it stays a best-effort AID: it returns null
// when it can't confidently parse (other sites, a bare connection note, no
// owner name), leaving the model as the message fallback.

const TIME_RE = String.raw`\d{1,2}:\d{2}\s*(?:[AaPp][Mm])`;
// A per-bubble author header: "<name><2+ spaces><time>". The 2+ space gap is
// LinkedIn's name↔timestamp separator and is what distinguishes a real header
// from a sentence that merely mentions a time.
const BUBBLE_HEADER_RE = new RegExp(String.raw`^(.+?)\s{2,}${TIME_RE}\s*$`);
// A group header: "<name> sent the following message(s) at <time>".
const GROUP_HEADER_RE = new RegExp(
  String.raw`^(.+?) sent the following messages? at ${TIME_RE}\s*$`,
  'i',
);
// Bubble chrome that is never body text and never an author signal.
const VIEW_PROFILE_RE = /^View\b.*\bprofile/i;
const DATE_SEP_RE =
  /^(?:today|yesterday|(?:mon|tues|wednes|thurs|fri|satur|sun)day|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2})$/i;

// Phrases that indicate a connection was just accepted (used only when the owner
// has sent no message in the fragment — an active thread is a direct_message).
const ACCEPTANCE_RE =
  /\b(?:accepted your (?:invitation|connection(?: request)?)|is now a connection|thanks for connecting|looking forward to connecting|nice to (?:meet|connect)|great to (?:be )?connect(?:ed|ing))\b/i;

function normalizeName(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

interface MessageBubble {
  author: string;
  body: string[];
}

/**
 * Extract the most recent message authored by `ownerName` from a plain-text
 * LinkedIn-style thread. Returns the message body as plain text (newline-joined),
 * or null when the owner name is unknown, the text isn't a parseable thread, or
 * the owner authored nothing here.
 */
export function extractOwnerMessage(text: string, ownerName: string): string | null {
  const owner = normalizeName(ownerName);
  if (!owner || !text) return null;

  // Trim each line but PRESERVE internal spacing: the 2+ space gap between a
  // sender name and the timestamp is the header signal (BUBBLE_HEADER_RE), so
  // collapsing it here would hide every header.
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const bubbles: MessageBubble[] = [];

  const startBubble = (author: string): void => {
    bubbles.push({ author: normalizeName(author), body: [] });
  };

  for (const line of lines) {
    if (!line) continue;
    const group = GROUP_HEADER_RE.exec(line);
    if (group) {
      startBubble(group[1]);
      continue;
    }
    const bubble = BUBBLE_HEADER_RE.exec(line);
    if (bubble) {
      startBubble(bubble[1]);
      continue;
    }
    if (VIEW_PROFILE_RE.test(line) || DATE_SEP_RE.test(line)) continue;
    // Body text before the first author header has no known sender — skip it.
    const last = bubbles[bubbles.length - 1];
    if (last) last.body.push(line);
  }

  for (let i = bubbles.length - 1; i >= 0; i--) {
    if (bubbles[i].author === owner) {
      const body = bubbles[i].body.join('\n').trim();
      if (body) return body;
    }
  }
  return null;
}

/**
 * Deterministic capture stage (spec 016 follow-up):
 *   • the owner sent a message in this fragment → 'direct_message'
 *   • else the content shows an acceptance       → 'accepted_connection'
 *   • else (a plain profile / a sent invite)     → 'connection_request'
 */
export function classifyStage(content: string, ownerMessage: string | null): EventType {
  if (ownerMessage !== null) return 'direct_message';
  if (ACCEPTANCE_RE.test(content ?? '')) return 'accepted_connection';
  return 'connection_request';
}

const _utf8Encoder = new TextEncoder();

/**
 * Cap a raw fragment to FRAGMENT_MAX_BYTES (UTF-8). A char is ≥ 1 byte, so the
 * answer never exceeds FRAGMENT_MAX_BYTES chars — pre-slice to that to bound the
 * binary search on whole-page (multi-MB) selections. Truncate back to the last
 * open-tag boundary when one is near the end (cheap), else byte-cut.
 */
export function capFragment(raw: string): string {
  if (!raw) return '';
  if (_utf8Encoder.encode(raw).length <= FRAGMENT_MAX_BYTES) return raw;

  // The max prefix is ≤ FRAGMENT_MAX_BYTES chars; bound the search to that.
  const bounded = raw.slice(0, FRAGMENT_MAX_BYTES);
  let lo = 0;
  let hi = bounded.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (_utf8Encoder.encode(bounded.slice(0, mid)).length <= FRAGMENT_MAX_BYTES) lo = mid;
    else hi = mid - 1;
  }
  let cut = bounded.slice(0, lo);
  // If the cut left a dangling open tag (a '<' with no following '>'), drop it.
  const lastLt = cut.lastIndexOf('<');
  if (lastLt > cut.lastIndexOf('>')) cut = cut.slice(0, lastLt);
  return cut;
}

/** Collect trimmed, whitespace-collapsed, non-empty text lines in document order. */
function collectTextLines(doc: Document): string[] {
  const lines: string[] = [];
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const t = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (t) lines.push(t);
  }
  return lines;
}

/** First absolute http(s) anchor href in the fragment, else ''. */
function firstUrl(doc: Document): string {
  for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
    const href = a.getAttribute('href') ?? '';
    if (/^https?:\/\//i.test(href)) return href;
  }
  return '';
}

function extractFromHtml(html: string): EditableEventFields {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return { name: '', title: '', linkedin_url: '', message_text: '' };
  }

  const linkedin_url = cleanUrl(firstUrl(doc));
  const lines = collectTextLines(doc);

  // Name: trust a real heading (h1–h4) first. Do NOT use <strong>/<b> — on a
  // search-result card the only bold node is the "is a mutual connection" decoy,
  // so trusting it picks the wrong person. Else: the first non-junk, non-URL line.
  const headingEl = doc.body.querySelector('h1,h2,h3,h4');
  let name = (headingEl?.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (!name) {
    name = lines.find((l) => !isJunkLine(l) && !/^https?:\/\//i.test(l)) ?? lines[0] ?? '';
  }

  // Title: the first line after the name that isn't the name, a bare URL, or UI
  // chrome (degree markers, pronoun chips, mutual-connection rollups, counts,
  // thread timestamps) — so we skip "He/Him" / "· 2nd" / "1st degree connection".
  let title = '';
  const nameIdx = lines.findIndex((l) => l === name);
  for (let i = Math.max(0, nameIdx) + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l && l !== name && !/^https?:\/\//i.test(l) && !isJunkLine(l)) {
      title = l;
      break;
    }
  }

  return { name, title, linkedin_url, message_text: '' };
}

function extractFromText(text: string): EditableEventFields {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  // Name: first non-junk, non-URL line (skips a leading pronoun/degree chip).
  const name = lines.find((l) => !isJunkLine(l) && !/^https?:\/\//i.test(l)) ?? lines[0] ?? '';
  // Title: first line after the name that isn't a bare URL or UI chrome.
  let title = '';
  const nameIdx = lines.findIndex((l) => l === name);
  for (let i = Math.max(0, nameIdx) + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l && l !== name && !/^https?:\/\//i.test(l) && !isJunkLine(l)) {
      title = l;
      break;
    }
  }
  // A pasted plain-text URL line becomes the profile URL (tracking stripped).
  const url = cleanUrl(lines.find((l) => /^https?:\/\//i.test(l)) ?? '');
  return { name, title, linkedin_url: url, message_text: '' };
}

/**
 * Heuristic extraction from a dropped/pasted fragment. Prefers the rich
 * `text/html` markup (absolute hrefs, headings); falls back to `text/plain`
 * line structure when no HTML is present. The fragment is capped to
 * FRAGMENT_MAX_BYTES before parsing.
 */
export function extractHeuristic(input: { html?: string; text?: string }): EditableEventFields {
  const html = input.html ? capFragment(input.html) : '';
  if (html.trim()) return extractFromHtml(html);
  if (input.text && input.text.trim()) return extractFromText(capFragment(input.text));
  return { name: '', title: '', linkedin_url: '', message_text: '' };
}

/**
 * Spec 016 D-016-2 / CEO-review decision 5 — site-agnostic confidence.
 * `'high'` (skip AI) only when the name looks like a real person AND a non-empty
 * `https:` URL is present; otherwise `'low'` (run the on-device model).
 */
export function heuristicConfidence(
  fields: Pick<EditableEventFields, 'name' | 'linkedin_url'>,
): ScrapeConfidence {
  return isPlausibleName(fields.name ?? '') && isHttpsUrl(fields.linkedin_url ?? '')
    ? 'high'
    : 'low';
}
