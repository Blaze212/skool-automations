// Score the NO-AI heuristic over the same 44 eval fixtures, in Node via jsdom.
// Compares the CURRENT capture-heuristic.ts logic against a proposed V2, so we
// can see how much the deterministic parser can get right on its own (→ lean on
// the model less). Pure JS (tsx/esbuild is broken on this platform).
//
//   node scripts/eval-heuristic.mjs
//
// Heuristic only produces name / title / linkedin_url (message_text + stage stay
// AI-only by design), so we score those three.

import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';

const dom = new JSDOM('<!doctype html><body></body>');
const { DOMParser, NodeFilter } = dom.window;

const { scoreField } = await import(pathToFileURL('drag-link-inspector 3/scoring.js').href);

const win = {};
new Function('window', readFileSync('drag-link-inspector 3/eval-dataset.js', 'utf8'))(win);
const DATA = win.EVAL_DATASET;

// ── shared bits (ported verbatim from capture-heuristic.ts) ──────────────────
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

function collectTextLines(doc) {
  const lines = [];
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const t = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (t) lines.push(t);
  }
  return lines;
}
function firstUrl(doc) {
  for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
    const href = a.getAttribute('href') ?? '';
    if (/^https?:\/\//i.test(href)) return href;
  }
  return '';
}

// ── CURRENT logic ────────────────────────────────────────────────────────────
function extractCurrent(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const linkedin_url = firstUrl(doc);
  const headingEl = doc.body.querySelector('h1,h2,h3,h4,strong,b');
  const headingText = (headingEl?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const lines = collectTextLines(doc);
  const name = headingText || lines[0] || '';
  let title = '';
  const nameIdx = lines.findIndex((l) => l === name);
  for (let i = Math.max(0, nameIdx) + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l && l !== name && !/^https?:\/\//i.test(l)) {
      title = l;
      break;
    }
  }
  return { name, title, linkedin_url };
}

// ── V2 logic ─────────────────────────────────────────────────────────────────
// Noise regexes reused from packages/scraping-core/src/validate.ts
const DEGREE_MARKER_RE = /(^|\s|·)(1st|2nd|3rd)(\s|·|$)/i;
const MUTUAL_CONNECTION_RE = /\bmutual\s+connection(s)?\b/i;
const PREMIUM_BADGE_RE = /\bpremium\b\s*(?:·|\||$)/i;
const OPEN_TO_WORK_RE = /\bopen\s+to\s+work\b/i;
const FOLLOWER_COUNT_RE = /\b[\d,.]+\s*[KMB]?\+?\s+follower(s)?\b/i;
// V2-only: degree-connection sentence, connection counts, chrome, thread chrome
const DEGREE_CONNECTION_RE = /\bdegree connection\b/i;
const CONNECTION_COUNT_RE = /^[·•\s]*[\d,.]+\s*\+?\s*connections?$/i;
const BULLET_ONLY_RE = /^[·•∙\s]+$/;
const CONTACT_INFO_RE = /^contact info$/i;
// Pronoun chip, bare or parenthesized: "He/Him", "(She/Her)", "they/them".
const PRONOUN_RE = /^\(?\s*(he|him|she|her|they|them)(\s*\/\s*(he|him|she|her|they|them))?\s*\)?$/i;
const THREAD_CHROME_RE =
  /(sent the following message|view .+? profile|^today$|^yesterday$|^(mon|tues|wednes|thurs|fri|satur|sun)day$|^\d{1,2}:\d{2}\s*(am|pm)$)/i;

function isJunkLine(l) {
  const s = l.trim();
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

function cleanUrl(u) {
  if (!u) return '';
  try {
    const url = new URL(u);
    // LinkedIn (and most profile sites): identity lives in the path; query is
    // pure tracking (?lipi, ?trk…). Drop query + hash.
    if (/(^|\.)linkedin\.com$/i.test(url.hostname)) return url.origin + url.pathname;
    // Other sites: strip only known tracking params, keep the rest.
    const TRACKING = /^(lipi|trk|utm_|original_referer|refId|miniProfileUrn)/i;
    for (const k of [...url.searchParams.keys()]) if (TRACKING.test(k)) url.searchParams.delete(k);
    url.hash = '';
    return url.toString();
  } catch {
    return u;
  }
}

function extractV2(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const linkedin_url = cleanUrl(firstUrl(doc));
  const lines = collectTextLines(doc);

  // Name: trust a real heading first (h1-h4). Do NOT use <strong>/<b> — on
  // search cards the only bold node is the "is a mutual connection" decoy.
  // Else: first non-junk, non-URL text line.
  const headingEl = doc.body.querySelector('h1,h2,h3,h4');
  let name = (headingEl?.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (!name) name = lines.find((l) => !isJunkLine(l) && !/^https?:\/\//i.test(l)) ?? lines[0] ?? '';

  // Title: first line after the name that isn't the name, a URL, or UI junk
  // (degree markers, pronouns, mutual-connection rollups, counts, thread chrome).
  let title = '';
  const nameIdx = lines.findIndex((l) => l === name);
  for (let i = Math.max(0, nameIdx) + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l && l !== name && !/^https?:\/\//i.test(l) && !isJunkLine(l)) {
      title = l;
      break;
    }
  }
  return { name, title, linkedin_url };
}

// ── scoring ──────────────────────────────────────────────────────────────────
const SCORED = ['name', 'title', 'linkedin_url'];
function run(extract, label) {
  const pass = { name: 0, title: 0, linkedin_url: 0 };
  const byCat = {};
  const misses = [];
  for (const c of DATA) {
    const fields = extract(c.trimmedHtml);
    byCat[c.category] ??= { n: 0, ok: 0 };
    byCat[c.category].n++;
    let allOk = true;
    const fail = [];
    for (const f of SCORED) {
      const r = scoreField(f, c.expected[f], fields[f]);
      if (r.pass) pass[f]++;
      else {
        allOk = false;
        fail.push(
          `      ${f}: exp=${JSON.stringify(c.expected[f])} got=${JSON.stringify(fields[f])}`,
        );
      }
    }
    if (allOk) byCat[c.category].ok++;
    else misses.push(`  ✗ ${c.id}\n${fail.join('\n')}`);
  }
  const n = DATA.length;
  const pct = (x) => `${Math.round((x / n) * 100)}%`.padStart(4);
  console.log(`\n=== ${label} (name/title/linkedin_url over ${n} fixtures) ===`);
  for (const f of SCORED) console.log(`  ${f.padEnd(13)} ${pct(pass[f])}  (${pass[f]}/${n})`);
  const allOk = Object.values(byCat).reduce((a, c) => a + c.ok, 0);
  console.log(`  ALL 3        ${pct(allOk)}  (${allOk}/${n})`);
  console.log('  by category:');
  for (const [cat, c] of Object.entries(byCat))
    console.log(
      `    ${String(Math.round((c.ok / c.n) * 100)).padStart(3)}%  ${c.ok}/${c.n}  ${cat}`,
    );
  return { pass, misses };
}

const cur = run(extractCurrent, 'CURRENT heuristic');
const v2 = run(extractV2, 'V2 heuristic');
console.log(`\n--- CURRENT misses (${cur.misses.length}) ---\n${cur.misses.join('\n')}`);
console.log(`\n--- V2 remaining misses (${v2.misses.length}) ---\n${v2.misses.join('\n')}`);
