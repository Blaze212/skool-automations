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

import type { EditableEventFields } from './sidepanel/editable-fields.ts';
import type { ScrapeConfidence } from './types.ts';

// Spec 016 E-10 — hard cap on the raw dropped fragment BEFORE DOMParser, so a
// whole-page selection can't jank the panel. The pipeline is:
//   raw ≤ FRAGMENT_MAX_BYTES → DOMParser → stripHtmlForCarry ≤ 16KB → AI.
export const FRAGMENT_MAX_BYTES = 64 * 1024;

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

  const linkedin_url = firstUrl(doc);

  // Name: prefer a heading / bold element (the most reliable "this is a person"
  // signal across sites); fall back to the first text line.
  const headingEl = doc.body.querySelector('h1,h2,h3,h4,strong,b');
  const headingText = (headingEl?.textContent ?? '').replace(/\s+/g, ' ').trim();

  const lines = collectTextLines(doc);
  const name = headingText || lines[0] || '';

  // Title: the first distinct line after the name that isn't the name itself or
  // a bare URL line.
  let title = '';
  const nameIdx = lines.findIndex((l) => l === name);
  for (let i = Math.max(0, nameIdx) + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l && l !== name && !/^https?:\/\//i.test(l)) {
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
  const name = lines[0] ?? '';
  // First following line that isn't a bare URL.
  let title = '';
  for (let i = 1; i < lines.length; i++) {
    if (!/^https?:\/\//i.test(lines[i])) {
      title = lines[i];
      break;
    }
  }
  // A pasted plain-text URL line becomes the profile URL.
  const url = lines.find((l) => /^https?:\/\//i.test(l)) ?? '';
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
