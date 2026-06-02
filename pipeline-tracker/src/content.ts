import {
  HISTORY_CAP,
  OUTBOX_CAP,
  STORAGE_KEYS,
  type DebugPayload,
  type ExtractionSource,
  type HistoryEntry,
  type OutboxEntry,
  type PipelineEvent,
} from './types.ts';
import {
  historyStore,
  outboxStore,
  recordStorageQuotaError,
  setOutboxAndHistory,
  setOutboxHistoryAndRecoveredHtml,
  settingsStore,
  StorageQuotaExceededError,
} from './storage.ts';
import { ts } from './logger.ts';
import { ConnectionSearchCard } from '../../linkedin-tracker/src/connection-search-card.ts';
import { ProfilePageCard } from '../../linkedin-tracker/src/profile-page-card.ts';
import { ProfilePageOwnerCard } from '../../linkedin-tracker/src/profile-page-owner-card.ts';
import {
  AcceptInvitationCard,
  ChatOverlayCard,
  extract,
  MessengerPageCard,
  ProfilePageAcceptCard,
  getCachedAvailability,
  recover,
  SalesNavConnectModalCard,
  SalesNavLeadCard,
  SalesNavMenuCard,
  stripHtmlForCarry,
  validate,
} from '@cs/scraping-core';

export { AcceptInvitationCard };
export { ProfilePageAcceptCard };
export { ChatOverlayCard };
export { MessengerPageCard };

// Injected by build.ts via esbuild define. Undefined under vitest only when a
// test forgets the define (the config sets it to 'internal'); treat absence as
// internal so recovered_html persistence stays off by default.
declare const BUILD_TARGET: 'internal' | 'publishable';
const IS_PUBLISHABLE_BUILD = typeof BUILD_TARGET !== 'undefined' && BUILD_TARGET === 'publishable';

const tag = () => `[Pipeline Tracker - ${ts()}]`;

// --- LinkedIn URL normalization ---
// TODO: this function is duplicated in accept-invitation-card.ts, chat-overlay-card.ts,
// and messenger-page-card.ts. Extract into a shared `linkedin-url.ts` module so the
// copies don't drift.
// TODO: split this file (currently >1k lines) along the flow boundary into
// `flows/{connection-request,accept-connection,direct-message}.ts` and a
// `messaging.ts` for sendEvent / drain retry / banner code. Content.ts should
// reduce to the document listener wiring + dispatch.
function normalizeLinkedInUrl(url: string): string {
  if (!url) return '';
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    const m = u.pathname.match(/^(\/in\/[^/?#]+)/);
    if (!m) return url;
    return `https://www.linkedin.com${m[1]}`;
  } catch {
    return url;
  }
}

// --- Deduplication ---
let _lastSent: { name: string; ts: number } | null = null;

export function resetDedup(): void {
  _lastSent = null;
}

function isDuplicate(name: string): boolean {
  if (!_lastSent) return false;
  return _lastSent.name === name && Date.now() - _lastSent.ts < 500;
}

function recordSent(name: string): void {
  _lastSent = { name, ts: Date.now() };
}

// --- Debug helpers ---
// Cached debug flag for sync code paths (click handler runs synchronously and
// can't await storage). Initialised from storage on script load and refreshed
// whenever the popup toggles the setting.
let _debugModeCached = false;
function isDebugModeSync(): boolean {
  return _debugModeCached;
}
try {
  chrome.storage.sync.get(STORAGE_KEYS.DEBUG_MODE, (result) => {
    _debugModeCached = !!(result as Record<string, unknown>)[STORAGE_KEYS.DEBUG_MODE];
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes[STORAGE_KEYS.DEBUG_MODE]) {
      _debugModeCached = !!changes[STORAGE_KEYS.DEBUG_MODE].newValue;
    }
  });
} catch {
  // chrome.storage unavailable (e.g. in tests) — leave _debugModeCached as false
}

async function getDebugMode(): Promise<boolean> {
  try {
    const result = await chrome.storage.sync.get(STORAGE_KEYS.DEBUG_MODE);
    return !!(result as Record<string, unknown>)[STORAGE_KEYS.DEBUG_MODE];
  } catch {
    return false;
  }
}

const DEBUG_HTML_CAP = 50000;

function buildDebugPayload(button: HTMLElement, container: HTMLElement | null): DebugPayload {
  return {
    button_aria_label: button.getAttribute('aria-label') ?? '',
    button_text: button.textContent?.trim() ?? '',
    container_html: (container?.outerHTML ?? '').substring(0, DEBUG_HTML_CAP),
    page_url: window.location.href,
  };
}

// Walk up from `anchor` until the ancestor's outerHTML is large enough to
// include useful surrounding context (recipient header, message bubbles, etc.).
// Stops at body. For the LinkedIn overlay chat bubble the composer form alone
// is only ~5-10k chars and excludes the title bar; the bubble root (which
// contains both header and thread) lands in the 20-40k range, so the threshold
// has to be comfortably past that. The cap in buildDebugPayload bounds the
// actual payload regardless.
function findDebugContainer(anchor: HTMLElement, minChars = DEBUG_HTML_CAP): HTMLElement {
  let node: HTMLElement = anchor;
  while (
    node.parentElement &&
    node.parentElement !== document.body &&
    node.outerHTML.length < minChars
  ) {
    node = node.parentElement;
  }
  return node;
}

// =============================================================================
// Robust DOM helpers — no CSS class selectors; only structural/semantic queries
// =============================================================================

// Text patterns that look like a headline but are actually noise
const TITLE_NOISE = /mutual connection|connection(s)?|follower(s)?|premium|open to work/i;

type Candidate = { value: string; strategy: string };

/**
 * Extract the person's name from a card container.
 * Runs ALL strategies, logs every candidate, returns the first non-empty result.
 *
 * Bug note: filter only <img> (not <svg>) — the name link legitimately contains
 * a badge <svg> (Verified, Premium, etc.) but no <img>. The avatar link has <img>.
 */
function extractNameFromCard(card: HTMLElement): string {
  const found: Candidate[] = [];

  // S1: /in/ link whose text has content — skip avatar links (they have <img>)
  const links = Array.from(card.querySelectorAll('a[href*="/in/"]')) as HTMLAnchorElement[];
  for (const link of links) {
    if (link.querySelector('img')) continue; // avatar link has <img>; name link has only <svg> badge
    const text = link.textContent?.trim() ?? '';
    if (text.length > 1) {
      found.push({ value: text, strategy: 'profile-link-text' });
      break;
    }
  }

  // S2: direct text nodes inside <strong>/<b> — strips badge spans and icons cleanly
  for (const el of Array.from(card.querySelectorAll('strong, b')) as HTMLElement[]) {
    const directText = Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => (n.textContent ?? '').trim())
      .filter((t) => t.length > 0)
      .join(' ');
    if (directText.length > 1) {
      found.push({ value: directText, strategy: 'bold-direct-text' });
      break;
    }
  }

  // S3: heading elements not inside anchors
  for (const h of Array.from(card.querySelectorAll('h1,h2,h3,h4')) as HTMLElement[]) {
    if (h.closest('a')) continue;
    const text = h.textContent?.trim() ?? '';
    if (text.length > 1) {
      found.push({ value: text, strategy: 'heading' });
      break;
    }
  }

  console.log(
    tag(),
    'name candidates:',
    found.map((c) => `[${c.strategy}] "${c.value.slice(0, 60)}"`),
  );
  return found[0]?.value ?? '';
}

/**
 * Extract the person's LinkedIn headline from a card container.
 * Runs ALL strategies, logs every candidate, returns the longest non-empty result.
 */
function extractTitleFromCard(card: HTMLElement): string {
  const found: Candidate[] = [];

  // S1: longest non-anchor <span> ≥ 15 chars, not noise, not starting with digit
  const spans = (Array.from(card.querySelectorAll('span')) as HTMLElement[])
    .filter((s) => {
      if (s.closest('a')) return false;
      const t = s.textContent?.trim() ?? '';
      return t.length >= 15 && !/^\d/.test(t) && !TITLE_NOISE.test(t);
    })
    .sort((a, b) => (b.textContent?.trim() ?? '').length - (a.textContent?.trim() ?? '').length);
  if (spans[0]) found.push({ value: spans[0].textContent!.trim(), strategy: 'span-longest' });

  // S2: first non-anchor <p> ≥ 15 chars, not noise
  for (const p of Array.from(card.querySelectorAll('p')) as HTMLElement[]) {
    if (p.closest('a')) continue;
    const t = p.textContent?.trim() ?? '';
    if (t.length >= 15 && !/^\d/.test(t) && !TITLE_NOISE.test(t)) {
      found.push({ value: t, strategy: 'para' });
      break;
    }
  }

  // S3: [title] attribute on any non-anchor element
  for (const el of Array.from(card.querySelectorAll('[title]')) as HTMLElement[]) {
    if (el.closest('a')) continue;
    const t = el.getAttribute('title') ?? '';
    if (t.length >= 15 && !/^\d/.test(t) && !TITLE_NOISE.test(t)) {
      found.push({ value: t, strategy: 'title-attr' });
      break;
    }
  }

  // S4: name-<p> sibling walk — search-results page structure.
  // LinkedIn puts the name link inside a <p>; the title is the next sibling element
  // that isn't an action (button / aria-labelled link). Mirrors ConnectionSearchCard.title.
  const namePara = Array.from(card.querySelectorAll('p')).find((p) =>
    p.querySelector('a[href*="/in/"]'),
  ) as HTMLElement | undefined;
  if (namePara) {
    let sib = namePara.nextElementSibling as HTMLElement | null;
    while (sib) {
      if (!sib.querySelector('button, a[aria-label]')) {
        const t = sib.textContent?.trim() ?? '';
        if (t.length >= 5 && !/^\d/.test(t) && !TITLE_NOISE.test(t)) {
          found.push({ value: t, strategy: 'name-para-sibling' });
          break;
        }
      }
      sib = sib.nextElementSibling as HTMLElement | null;
    }
  }

  // S5: heading ancestor sibling-<p> — profile-page sidebar card structure.
  // Mirrors ProfilePageCard.title: walk up from the heading, check sibling <p> elements.
  const heading = card.querySelector('h1,h2,h3') as HTMLElement | null;
  if (heading) {
    let node: HTMLElement | null = heading.parentElement;
    outer: while (node && node !== card) {
      let sib = node.nextElementSibling as HTMLElement | null;
      while (sib) {
        if (sib.tagName === 'P') {
          const t = sib.textContent?.trim() ?? '';
          if (t.length >= 5 && !t.startsWith('·') && !/^\d/.test(t) && !TITLE_NOISE.test(t)) {
            found.push({ value: t, strategy: 'heading-sibling-p' });
            break outer;
          }
        }
        sib = sib.nextElementSibling as HTMLElement | null;
      }
      node = node.parentElement;
    }
  }

  console.log(
    tag(),
    'title candidates:',
    found.map((c) => `[${c.strategy}] "${c.value.slice(0, 80)}"`),
  );
  // Best = longest (longer headline = more specific = less likely to be noise)
  return found.sort((a, b) => b.value.length - a.value.length)[0]?.value ?? '';
}

/**
 * Extract and normalize the profile URL from a card container.
 * a[href*="/in/"] is the most stable LinkedIn selector.
 */
function extractProfileUrlFromCard(card: HTMLElement): string {
  const anchors = Array.from(card.querySelectorAll('a[href*="/in/"]')) as HTMLAnchorElement[];
  // Prefer the text link (no img) over the avatar link; fall back to any /in/ link
  const preferred = anchors.find((a) => !a.querySelector('img')) ?? anchors[0] ?? null;
  return normalizeLinkedInUrl(preferred?.href ?? '');
}

/**
 * Walk up from a click target to find the nearest invitation card
 * (a [role="listitem"] or <li> that contains an Accept or Ignore button).
 * Used to log extraction previews on any click near the card.
 */
function findNearestInvitationCard(target: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = target;
  while (node && node !== document.body) {
    const role = node.getAttribute('role');
    if (role === 'listitem' || node.tagName === 'LI') {
      // Primary: explicit Accept/Ignore aria-label
      if (node.querySelector('button[aria-label*="Accept" i], button[aria-label*="Ignore" i]')) {
        return node;
      }
      // Fallback: any listitem with a profile link + button (generic invitation card shape)
      if (node.querySelector('a[href*="/in/"]') && node.querySelector('button')) {
        return node;
      }
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * Log a full extraction preview for an invitation card.
 * Fires on ANY click within the card so you can verify data capture
 * before committing to the Accept action.
 */
function logCardPreview(card: HTMLElement): void {
  console.log(tag(), '── CARD PREVIEW ──────────────────────────');
  const name = extractNameFromCard(card);
  const title = extractTitleFromCard(card);
  const linkedin_url = extractProfileUrlFromCard(card);
  const messageText =
    card.querySelector('[data-testid="expandable-text-box"]')?.textContent?.trim() ?? '';
  console.log(tag(), 'PREVIEW result:', {
    name: name || '(not found)',
    title: title || '(not found)',
    linkedin_url: linkedin_url || '(not found)',
    message_text: messageText || '(empty)',
  });
  console.log(tag(), '─────────────────────────────────────────');
}

/**
 * Fallback accept-button detection using document.elementsFromPoint.
 *
 * composedPath() only contains ancestors of the click target — it misses the Accept
 * button when LinkedIn's display:contents wrapper divs cause the click to land on
 * a sibling/cousin element rather than the button itself.
 *
 * elementsFromPoint returns ALL elements stacked at (x, y) regardless of DOM position,
 * z-index, or pointer-events. We scan that list for a button with an accept aria-label,
 * then walk each hit element up a few levels in case the click landed on a child span.
 */
function findAcceptButtonAtPoint(x: number, y: number): HTMLElement | null {
  const elements = document.elementsFromPoint(x, y) as HTMLElement[];
  if (isDebugModeSync()) {
    console.log(
      tag(),
      'elementsFromPoint:',
      elements
        .slice(0, 8)
        .map((el) => {
          const label = el.getAttribute('aria-label');
          return `${el.tagName}${label ? '[aria=' + label.slice(0, 40) + ']' : ''}`;
        })
        .join(' → '),
    );
  }

  for (const el of elements) {
    // Direct hit: this element IS the accept button
    const label = (el.getAttribute('aria-label') ?? '').toLowerCase();
    const text = el.textContent?.trim().toLowerCase() ?? '';
    if (
      (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') &&
      label.includes('accept') &&
      (label.includes('invit') || label.includes('connect') || label.includes('request'))
    ) {
      console.log(
        tag(),
        'accept: direct hit via elementsFromPoint, label=',
        el.getAttribute('aria-label'),
      );
      return el;
    }
    // Span/div inside the button — walk up to the button
    if (text === 'accept' || label.includes('accept')) {
      let node: HTMLElement | null = el.parentElement;
      for (let i = 0; i < 4 && node && node !== document.body; i++) {
        const nodeLabel = (node.getAttribute('aria-label') ?? '').toLowerCase();
        if (
          (node.tagName === 'BUTTON' || node.getAttribute('role') === 'button') &&
          nodeLabel.includes('accept') &&
          (nodeLabel.includes('invit') ||
            nodeLabel.includes('connect') ||
            nodeLabel.includes('request'))
        ) {
          console.log(
            tag(),
            'accept: ancestor hit via elementsFromPoint, label=',
            node.getAttribute('aria-label'),
          );
          return node;
        }
        node = node.parentElement;
      }
    }
  }
  return null;
}

// --- Send helper ---

function isContextInvalidated(err: unknown): boolean {
  // An orphaned content script (extension reloaded/updated, or the browser
  // updated while the tab stayed open) has its chrome.* namespaces torn down.
  // Two shapes show up in the wild:
  //   1. chrome.runtime.sendMessage rejects with "Extension context invalidated".
  //   2. chrome.storage is already undefined, so property access throws a plain
  //      TypeError ("Cannot read properties of undefined") before any documented
  //      message is produced.
  // chrome.runtime.id goes undefined for both, so it's the reliable signal;
  // check it first, then fall back to the message match for the case where the
  // id is still present but sendMessage reports the classic error.
  try {
    const runtime = (chrome as { runtime?: { id?: string } } | undefined)?.runtime;
    if (!runtime || !runtime.id) return true;
  } catch {
    return true;
  }
  if (!(err instanceof Error)) return false;
  return /Extension context invalidated/i.test(err.message);
}

/**
 * The MV3 service worker is dead but the content script's chrome.* namespace is
 * still valid. Chrome is *supposed* to auto-revive the SW when sendMessage is
 * called, but the wake can race or fail outright — these error shapes are how
 * we know that happened so we can retry / surface a banner instead of dropping
 * the event silently.
 */
function isServiceWorkerUnreachable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return (
    /Could not establish connection/i.test(msg) ||
    /Receiving end does not exist/i.test(msg) ||
    /message port closed/i.test(msg) ||
    /service worker/i.test(msg)
  );
}

let _bannerShown = false;

/** Test-only: reset the once-per-page banner guard between cases. */
export function resetContextBanner(): void {
  _bannerShown = false;
}

function showReloadBanner(message: string): void {
  if (_bannerShown) return;
  _bannerShown = true;
  try {
    const host = document.createElement('div');
    host.id = 'pipeline-tracker-reload-banner';
    host.style.position = 'fixed';
    host.style.bottom = '16px';
    host.style.right = '16px';
    host.style.zIndex = '2147483647';
    const shadow = host.attachShadow({ mode: 'closed' });
    const banner = document.createElement('div');
    banner.textContent = message;
    banner.style.cssText = [
      'font-family: -apple-system, BlinkMacSystemFont, sans-serif',
      'font-size: 13px',
      'font-weight: 600',
      'background: #dc2626',
      'color: #fff',
      'padding: 12px 16px',
      'border-radius: 6px',
      'box-shadow: 0 4px 12px rgba(0,0,0,0.3)',
      'cursor: pointer',
      'max-width: 340px',
      'border: 2px solid #fca5a5',
    ].join(';');
    banner.addEventListener('click', () => {
      window.location.reload();
    });
    shadow.appendChild(banner);
    document.body.appendChild(host);
  } catch (err) {
    console.warn(tag(), 'failed to inject reload banner:', err);
  }
}

function showContextInvalidatedBanner(): void {
  showReloadBanner(
    'Pipeline Tracker stopped capturing events — the extension was updated. Click to reload this tab.',
  );
}

function showServiceWorkerUnreachableBanner(): void {
  showReloadBanner(
    'Pipeline Tracker cannot reach its background service. Events are not being logged. Click to reload this tab.',
  );
}

// --- Session rescue buffer ---
//
// When enqueuePendingEvent fails (extension context invalidated or unexpected IO
// error), the event was never written to chrome.storage.local. sessionStorage
// survives location.reload() within the same tab, so we stash the raw
// PipelineEvent there. replayRescueBuffer() is called on every content-script
// load; when storage is healthy again the rescued events are fed back through
// sendEvent() as if they'd just been captured.

const RESCUE_BUFFER_KEY = 'pipeline_tracker_rescued_events';

function saveToRescueBuffer(event: PipelineEvent): void {
  try {
    const raw = sessionStorage.getItem(RESCUE_BUFFER_KEY);
    const existing: PipelineEvent[] = raw ? (JSON.parse(raw) as PipelineEvent[]) : [];
    existing.push(event);
    sessionStorage.setItem(RESCUE_BUFFER_KEY, JSON.stringify(existing));
    console.log(tag(), `event saved to rescue buffer (${existing.length} buffered)`);
  } catch (err) {
    console.warn(tag(), 'failed to write rescue buffer:', err);
  }
}

async function enqueuePendingEvent(
  outboxEntry: OutboxEntry,
  pendingHistoryEntry: HistoryEntry,
  recoveredHtml?: string,
): Promise<void> {
  const [prevOutbox, prevHistory] = await Promise.all([outboxStore.get(), historyStore.get()]);

  // Outbox is FIFO with cap; drop oldest if at cap.
  const outbox = [...prevOutbox, outboxEntry].slice(-OUTBOX_CAP);
  const history = [pendingHistoryEntry, ...prevHistory].slice(0, HISTORY_CAP);

  // Atomic — outbox + history (+ recovered_html for AI-recovered rows) land in
  // one storage write so a quota failure on a second write can't leave the
  // outbox ahead of history or orphan recovered_html bytes (spec 013 D-rev-28).
  if (recoveredHtml) {
    await setOutboxHistoryAndRecoveredHtml(outbox, history, outboxEntry.history_id, recoveredHtml);
  } else {
    await setOutboxAndHistory(outbox, history);
  }
}

/**
 * Send a drain request to the background service worker with retry-on-wake.
 *
 * MV3 service workers die after ~30s idle and Chrome is *supposed* to revive
 * them when sendMessage is called, but the wake can lose its race or fail
 * outright — sendMessage then rejects with "Could not establish connection" or
 * "message port closed". Without retry we drop the signal entirely; with one
 * retry after a short delay the SW has time to spin up and the second attempt
 * usually succeeds.
 *
 * After exhausting retries, throws — caller surfaces the loud banner.
 */
const SW_WAKE_RETRY_DELAYS_MS = [150, 400];

async function sendDrainRequestWithRetry(): Promise<void> {
  let lastErr: unknown;
  // First attempt + len(delays) retries. So with [150, 400] that's 3 attempts total.
  for (let attempt = 0; attempt <= SW_WAKE_RETRY_DELAYS_MS.length; attempt++) {
    try {
      await chrome.runtime.sendMessage({ kind: 'drain_outbox' });
      if (attempt > 0) {
        console.log(tag(), `drain request succeeded on retry attempt ${attempt}`);
      } else {
        console.log(tag(), 'drain requested');
      }
      return;
    } catch (err) {
      lastErr = err;
      if (isContextInvalidated(err)) {
        // Context invalidation isn't recoverable — bail immediately so caller
        // shows the context-invalidated banner.
        throw err;
      }
      if (!isServiceWorkerUnreachable(err)) {
        // Unknown error — don't waste retries; let caller log/surface it.
        throw err;
      }
      const delay = SW_WAKE_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) break; // out of retries
      console.warn(tag(), `SW unreachable on attempt ${attempt + 1}; retrying in ${delay}ms`);
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

/**
 * Spec 013 — extraction provenance threaded from extract() at the call site.
 * `source` is stamped onto the wire event; `recoveredHtml` is the stripped
 * subtree fed to the on-device model, persisted ONLY in the publishable build
 * (the internal build ignores it — its webhook owns the canonical row).
 */
interface SendEventMeta {
  source?: ExtractionSource;
  recoveredHtml?: string;
}

async function sendEvent(event: PipelineEvent, meta: SendEventMeta = {}): Promise<void> {
  // Pre-flight validation: log structural gaps + noise hits so they show up in
  // the page console alongside the per-flow extraction logs. Severity-driving
  // logic stays in background.ts (effectiveSeverity); validate() is a strict
  // observer here — no payload mutation, no skip. Spec 011 phase 3.
  const validation = validate(event);
  if (validation.dirty) {
    console.warn(
      tag(),
      'validation gaps:',
      validation.gaps.map((g) => `${g.field}:${g.code}`).join(', '),
    );
  }

  // Stamp provenance so the side panel / CSV render the AI badge. 'selectors'
  // is the implicit default downstream, so only stamp the non-default value.
  if (meta.source === 'ai-recovered') event.source = 'ai-recovered';

  // recovered_html carry-through is publishable-only. The accept flow (the sole
  // caller passing recoveredHtml) is never a messenger card, so the D-AI-2
  // side-channel closure can't trigger here; when DM/connection flows route
  // through extract(), apply the capture_message_bodies guard at this seam.
  const recoveredHtml =
    IS_PUBLISHABLE_BUILD && meta.source === 'ai-recovered' ? meta.recoveredHtml : undefined;

  const historyId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString();

  const outboxEntry: OutboxEntry = {
    history_id: historyId,
    event,
    enqueued_at: now,
    attempts: 0,
  };

  const pendingHistoryEntry: HistoryEntry = {
    id: historyId,
    ts: now,
    status: 'pending',
    event_type: event.event_type,
    name: event.name,
    page_url: event.page_url,
    message: 'Queued - waiting to sync',
    warnings: [],
  };

  try {
    await enqueuePendingEvent(outboxEntry, pendingHistoryEntry, recoveredHtml);
  } catch (err) {
    // enqueue is the first chrome.* call on the capture path, so when the
    // extension context is invalidated (orphaned content script after an
    // extension/browser update) it throws here — before sendMessage. Detect it
    // at this point too, otherwise the reload banner below is never reached and
    // the event is dropped with only a swallowed warning.
    if (isContextInvalidated(err)) {
      console.warn(tag(), 'extension context invalidated — showing reload banner');
      saveToRescueBuffer(event);
      showContextInvalidatedBanner();
    } else if (err instanceof StorageQuotaExceededError) {
      // Spec 012 D-rev-11a: surface quota failure as a HistoryEntry so the user
      // sees a red row in the popup. Further capture will keep failing here
      // (and re-emitting) until they clear history to free space.
      console.warn(tag(), 'chrome.storage.local quota exceeded — recording STORAGE_QUOTA row');
      await recordStorageQuotaError({
        id: historyId,
        pageUrl: event.page_url,
        name: event.name,
        eventType: event.event_type,
      });
    } else {
      console.error(tag(), 'failed to enqueue event:', err);
      saveToRescueBuffer(event);
      showReloadBanner(
        'Pipeline Tracker failed to save an event. Capture is broken — click to reload this tab.',
      );
    }
    return;
  }

  try {
    await sendDrainRequestWithRetry();
  } catch (err) {
    if (isContextInvalidated(err)) {
      console.warn(tag(), 'extension context invalidated — showing reload banner');
      showContextInvalidatedBanner();
      return;
    }
    if (isServiceWorkerUnreachable(err)) {
      // Event is safely in the outbox; the alarm-driven keep-alive drain in the
      // SW will pick it up if the SW eventually wakes. But from the user's POV
      // the plugin "just died" — fail loudly so they know to reload.
      console.error(tag(), 'background service worker unreachable after retries:', err);
      showServiceWorkerUnreachableBanner();
      return;
    }
    // Some other unexpected sendMessage failure — surface it loudly too. We'd
    // rather over-warn than silently swallow events on a "production" path.
    console.error(tag(), 'drain request failed unexpectedly:', err);
    showReloadBanner(
      'Pipeline Tracker hit an unexpected error sending an event. Click to reload this tab.',
    );
  }
}

export async function replayRescueBuffer(): Promise<void> {
  let events: PipelineEvent[];
  try {
    const raw = sessionStorage.getItem(RESCUE_BUFFER_KEY);
    if (!raw) return;
    events = JSON.parse(raw) as PipelineEvent[];
    sessionStorage.removeItem(RESCUE_BUFFER_KEY);
    if (events.length === 0) return;
  } catch {
    sessionStorage.removeItem(RESCUE_BUFFER_KEY);
    return;
  }
  console.log(tag(), `replaying ${events.length} rescued event(s) from session buffer`);
  for (const event of events) {
    await sendEvent(event);
  }
}

/** Test-only: reset the session rescue buffer between cases. */
export function resetRescueBuffer(): void {
  sessionStorage.removeItem(RESCUE_BUFFER_KEY);
}

// =============================================================================
// Flow 1: Outbound connection request
// =============================================================================

// Staged on "Invite X to connect" click, consumed on the modal's "Send" click.
// TTL guards against SPA navigation away from the staged person without sending —
// without it, the next "Send" on a different person would silently use stale data.
const PENDING_CONNECTION_TTL_MS = 60_000;
let _pendingConnection: {
  name: string;
  title: string;
  profileUrl: string;
  ts: number;
} | null = null;

function readPendingConnection(): { name: string; title: string; profileUrl: string } | null {
  if (!_pendingConnection) return null;
  if (Date.now() - _pendingConnection.ts > PENDING_CONNECTION_TTL_MS) {
    _pendingConnection = null;
    return null;
  }
  return {
    name: _pendingConnection.name,
    title: _pendingConnection.title,
    profileUrl: _pendingConnection.profileUrl,
  };
}

export async function handleConnectionRequest(
  el: HTMLElement,
  pendingName?: string,
  pendingTitle?: string,
  pendingProfileUrl?: string,
): Promise<void> {
  console.log(tag(), 'handleConnectionRequest called, pendingName:', pendingName);
  const modal = el.closest('[role="dialog"]') as HTMLElement | null;

  let name = pendingName ?? '';
  const ariaLabel = el.getAttribute('aria-label') ?? '';

  // "Send invite to [Name]"
  if (!name) {
    const m = ariaLabel.match(/^Send invite to (.+)$/i);
    if (m) name = m[1].trim();
  }
  // Same pattern on another button inside the modal
  if (!name && modal) {
    const inviteBtn = modal.querySelector('[aria-label^="Send invite to "]') as HTMLElement | null;
    const m = inviteBtn?.getAttribute('aria-label')?.match(/^Send invite to (.+)$/i);
    if (m) name = m[1].trim();
  }
  // Profile link text inside the modal
  if (!name && modal) {
    const profileLink = modal.querySelector('a[href*="/in/"]') as HTMLAnchorElement | null;
    if (profileLink && !profileLink.querySelector('img, svg')) {
      name = profileLink.textContent?.trim() ?? '';
    }
  }

  let title = pendingTitle ?? '';
  let profileUrl = normalizeLinkedInUrl(pendingProfileUrl ?? '');

  // Profile-page fallback: on /in/{vanity}/ pages, the Connect button may have
  // been missed at click time (LinkedIn's display:contents wrappers can drop
  // the button from composedPath), leaving us with no pending data. Prefer the
  // profile page itself over the modal — on the "Add a note" variant the
  // modal h2 reads "Add a note to your invitation" (UI title, not the
  // recipient) and the body paragraph is generic invitation copy. The URL
  // pins the vanity so we can read the page directly.
  const ownerCard = ProfilePageOwnerCard.fromCurrentUrl();
  if (!name || !title || !profileUrl) {
    if (ownerCard) {
      if (!name) name = ownerCard.name;
      if (!title) title = ownerCard.title;
      if (!profileUrl) profileUrl = ownerCard.profileUrl;
    }
  }

  // Last resort: modal heading. Used only when the pending data and the
  // profile-page scrape both failed (e.g., flows not anchored to /in/).
  if (!name && modal) {
    const heading = modal.querySelector('h2, h3, h4') as HTMLElement | null;
    name = heading?.textContent?.trim() ?? '';
  }

  console.log(tag(), 'Flow 1: name=', name, 'title=', title);
  if (!name) console.warn(tag(), 'Flow 1: could not find name in modal');

  const debugMode = await getDebugMode();
  // Capture the profile-page DOM (where name/title/profileUrl are sourced)
  // rather than the modal, which on the "Add a note" flow contains only UI
  // copy. Fall back to <body> when no <main> exists (off-profile flows).
  const debugContainer = (document.querySelector('main, [role="main"]') ??
    document.body) as HTMLElement;
  const debug = debugMode ? buildDebugPayload(el, debugContainer) : undefined;

  if (isDuplicate(name)) return;
  recordSent(name);

  const event: PipelineEvent = {
    api_key: '',
    event_type: 'connection_request',
    date: new Date().toISOString().slice(0, 10),
    name,
    title,
    linkedin_url: profileUrl,
    page_url: window.location.href,
    message_text: '',
    ...(debug ? { debug } : {}),
  };

  // Spec 013 — on-device AI fallback for the connection-request flow. Mirrors
  // extract()'s gate: only when the user opted in, the scrape came back dirty,
  // and the model is locally available. recover() never throws, so a null
  // return cleanly degrades to a selectors-only row. The profile owner card's
  // section is the HTML context (stripHtmlForCarry trims it to fit Nano's
  // context window); off-profile surfaces have no owner card and are skipped.
  const recovered = await maybeRecoverConnectFields(event, ownerCard);

  console.log(tag(), 'sending event:', JSON.stringify(event));
  await sendEvent(event, recovered);
}

/**
 * Run the on-device AI fallback for a connection-request event when enabled,
 * dirty, and the model is available. Mutates `event` in place with recovered
 * fields and returns the provenance to pass to sendEvent.
 */
async function maybeRecoverConnectFields(
  event: PipelineEvent,
  ownerCard: ProfilePageOwnerCard | null,
): Promise<{ source?: ExtractionSource; recoveredHtml?: string }> {
  // AI recovery is an enhancement, never a capture dependency (spec D-AI-1):
  // any error here — settings read, availability probe, model — must degrade
  // to a selectors-only row, not break the send path.
  try {
    const settings = await settingsStore.get();
    if (!settings.ai_fallback_enabled || !ownerCard) return {};

    const validation = validate(event);
    if (!validation.dirty) return {};
    if ((await getCachedAvailability()) !== 'available') return {};

    const trimmedHtml = stripHtmlForCarry(ownerCard.container.outerHTML);
    if (!trimmedHtml) return {};

    const result = await recover({
      trimmedHtml,
      candidate: event,
      gaps: validation.gaps,
      pageUrl: event.page_url,
    });
    if (!result) return {};

    event.name = result.filledEvent.name;
    event.title = result.filledEvent.title;
    event.linkedin_url = result.filledEvent.linkedin_url;
    event.message_text = result.filledEvent.message_text;
    console.log(tag(), 'connect: fields recovered on-device by AI fallback');
    return { source: 'ai-recovered', recoveredHtml: trimmedHtml };
  } catch (err) {
    console.warn(tag(), 'connect: AI fallback errored — using selectors', err);
    return {};
  }
}

// =============================================================================
// Flow 1 (Sales Navigator): Outbound connection request
//
// Sales Nav's connect flow mirrors regular LinkedIn's two-click shape: the user
// clicks "Connect" (in a search-row "…" menu, a profile preview menu, or the
// lead-header overflow), then confirms in the "Send invitation" modal. The
// trigger surfaces are detached popover menus that carry only links — no name
// or headline — so we stage the profile URL (and, on a lead page, the name +
// headline) on the Connect click, then read the authoritative recipient name
// and the optional note from the modal on "Send Invitation".
//
// This reuses the shared `_pendingConnection` staging slot and the regular
// sendEvent/dedup machinery; only the card sources differ. Sales Nav runs at
// linkedin.com/sales/* so the existing content_scripts match already covers it.
// =============================================================================

const SALES_NAV_PATH_RE = /^\/sales\//;

function isSalesNavPage(): boolean {
  return SALES_NAV_PATH_RE.test(window.location.pathname);
}

/**
 * Stage data on a Sales Nav "Connect" click. The menu (when the click was in
 * one) yields the profile URL — possibly the public /in/ URL via "View LinkedIn
 * profile"; the lead header (when we're on a lead page) yields the name +
 * headline the modal can't supply. Written to the shared `_pendingConnection`
 * slot consumed by handleSalesNavConnectionRequest on the modal Send click.
 */
export function stageSalesNavConnect(connectButton: HTMLElement): void {
  const menuCard = SalesNavMenuCard.fromMenuItem(connectButton);
  const leadCard =
    SalesNavLeadCard.fromActionButton(connectButton) ?? SalesNavLeadCard.fromDocument();

  // Prefer the menu's URL (it may be the canonical public profile) and fall
  // back to the lead header's.
  const profileUrl = menuCard?.profileUrl || leadCard?.profileUrl || '';

  _pendingConnection = {
    name: leadCard?.name ?? '',
    title: leadCard?.title ?? '',
    profileUrl,
    ts: Date.now(),
  };
  console.log(tag(), 'captured (sales-nav connect click):', {
    name: _pendingConnection.name,
    title: _pendingConnection.title,
    profile_url: _pendingConnection.profileUrl,
  });
}

export async function handleSalesNavConnectionRequest(
  sendButton: HTMLElement,
  pendingName?: string,
  pendingTitle?: string,
  pendingProfileUrl?: string,
): Promise<void> {
  const modalCard =
    SalesNavConnectModalCard.fromSendButton(sendButton) ?? SalesNavConnectModalCard.fromDocument();

  // The modal is the confirm dialog, so its recipient name is authoritative;
  // the staged name is the fallback. Title + URL only exist in the staged data
  // (the modal carries neither).
  let name = modalCard?.name || pendingName || '';
  let title = pendingTitle ?? '';
  let profileUrl = normalizeLinkedInUrl(pendingProfileUrl ?? '');
  const messageText = modalCard?.messageText ?? '';

  // Lead-page fallback: when the Connect click never staged (fired from a
  // surface we didn't catch), read name/title/url straight off the lead header.
  if (!name || !title || !profileUrl) {
    const leadCard = SalesNavLeadCard.fromDocument();
    if (leadCard) {
      if (!name) name = leadCard.name;
      if (!title) title = leadCard.title;
      if (!profileUrl) profileUrl = leadCard.profileUrl;
    }
  }

  console.log(tag(), 'Sales Nav Flow 1: name=', name, 'title=', title);
  if (!name) console.warn(tag(), 'Sales Nav Flow 1: could not find recipient name');

  const debugMode = await getDebugMode();
  const debugContainer = (modalCard?.container ??
    SalesNavLeadCard.fromDocument()?.container ??
    document.body) as HTMLElement;
  const debug = debugMode ? buildDebugPayload(sendButton, debugContainer) : undefined;

  if (isDuplicate(name)) return;
  recordSent(name);

  const event: PipelineEvent = {
    api_key: '',
    event_type: 'connection_request',
    date: new Date().toISOString().slice(0, 10),
    name,
    title,
    linkedin_url: profileUrl,
    page_url: window.location.href,
    message_text: messageText,
    ...(debug ? { debug } : {}),
  };

  console.log(tag(), 'sending sales-nav event:', JSON.stringify(event));
  await sendEvent(event);
}

// =============================================================================
// Flow 2 + 3: Accept connection (My Network page OR Profile page)
// Merged into one handler — structural helpers handle both DOM shapes.
// =============================================================================

async function handleAcceptConnection(button: HTMLElement): Promise<void> {
  // Card routing + extraction + validation all live in @cs/scraping-core's
  // extract() now (spec 011 phase 4). content.ts owns only the chrome-side
  // wiring: debug-payload assembly, dedup, and the sendEvent dispatch.
  //
  // Single-probe pattern: probe both cards ONCE, here, and pass the winner to
  // both the orchestrator (for field extraction) AND the debug-container
  // assembly. Re-probing for the debug path opens a TOCTOU window where React
  // can swap the DOM between probes, causing debug.container_html to belong to
  // a different snapshot than event.{name,title,linkedin_url} — exactly the
  // case the debug payload exists to diagnose.
  const inviteCard =
    AcceptInvitationCard.fromAcceptButton(button) ?? ProfilePageAcceptCard.fromAcceptButton(button);

  // Card type diagnostic uses the same single probe that drives routing — the
  // logged type always matches the card whose data was actually used.
  const cardType =
    inviteCard instanceof AcceptInvitationCard
      ? 'my-network'
      : inviteCard instanceof ProfilePageAcceptCard
        ? 'profile-page'
        : 'none';
  console.log(
    tag(),
    'accept: ariaLabel=',
    JSON.stringify(button.getAttribute('aria-label') ?? ''),
    'card type=',
    cardType,
  );

  const settings = await settingsStore.get();
  const result = await extract({
    document,
    target: button,
    pageUrl: window.location.href,
    eventType: 'accepted_connection',
    aiOptions: { enabled: settings.ai_fallback_enabled },
  });
  const { event, validation } = result;
  if (result.source === 'ai-recovered') {
    console.log(tag(), 'accept: fields recovered on-device by AI fallback');
  }
  if (!event.name) console.warn(tag(), 'accept: could not find name');
  if (!event.title) console.warn(tag(), 'accept: could not find title');
  if (validation.dirty) {
    // Surface the orchestrator's validation result here at the call site —
    // spec 013's AI fallback decision lives at this seam. sendEvent runs
    // validate() again today for badge severity; this log captures the
    // upstream signal so we don't lose it.
    console.warn(
      tag(),
      'accept: validation gaps=',
      validation.gaps.map((g) => `${g.field}:${g.code}`).join(','),
    );
  }

  const debugMode = await getDebugMode();
  const debug = debugMode
    ? buildDebugPayload(button, inviteCard?.container ?? findDebugContainer(button))
    : undefined;

  if (isDuplicate(event.name)) return;
  recordSent(event.name);

  console.log(tag(), 'captured (accept click):', {
    name: event.name,
    title: event.title,
    linkedin_url: event.linkedin_url,
  });

  const finalEvent: PipelineEvent = debug ? { ...event, debug } : event;
  await sendEvent(finalEvent, { source: result.source, recoveredHtml: result.recoveredHtml });
}

// =============================================================================
// Flow: Direct message
// =============================================================================

export async function handleDirectMessage(button: HTMLElement | null): Promise<void> {
  const anchor = button ?? (document.activeElement as HTMLElement | null);
  let composerContainer: HTMLElement | null = null;
  let node: HTMLElement | null = anchor?.parentElement ?? null;
  while (node && node !== document.body && node !== document.documentElement) {
    if (node.querySelector('[contenteditable="true"]')) {
      composerContainer = node;
      break;
    }
    node = node.parentElement;
  }

  const composer = (composerContainer?.querySelector('[contenteditable="true"]') ??
    document.querySelector('[contenteditable="true"][role="textbox"]') ??
    document.querySelector('[contenteditable="true"]') ??
    (document.activeElement?.getAttribute('contenteditable') === 'true'
      ? document.activeElement
      : null)) as HTMLElement | null;
  const messageText = composer?.textContent?.trim() ?? '';

  let name = '';
  let linkedin_url = '';
  let title = '';

  // Strategy 0: scope to the chat overlay bubble around the composer.
  // This is the only path that guarantees title is never sourced from a message
  // body — which would let a URL the recipient sent leak into the title field.
  if (composer) {
    const chatCard = ChatOverlayCard.fromComposer(composer);
    if (chatCard) {
      name = chatCard.name;
      title = chatCard.title;
      linkedin_url = chatCard.profileUrl;
      console.log(tag(), 'DM: extracted via ChatOverlayCard');
    }
  }

  // Strategy 0.5: full messenger page (/messaging/thread/...). The title bar
  // header is always present even when the .msg-s-profile-card has scrolled
  // out of view, so this works even on long active threads.
  if (!name) {
    const pageCard = MessengerPageCard.fromDocument();
    if (pageCard) {
      name = pageCard.name;
      title = pageCard.title;
      linkedin_url = pageCard.profileUrl;
      console.log(tag(), 'DM: extracted via MessengerPageCard');
    }
  }

  // Strategy 1: profile card anywhere on the page — try multiple selector forms
  // (class names change; [data-testid] is more stable). Only run if Strategy 0
  // didn't already find a chat-overlay-scoped card; otherwise an unrelated
  // profile card elsewhere in the document could overwrite the correct values.
  const cardSelectors = [
    '[data-testid*="profile-card"]',
    '[data-testid*="convo-header"]',
    '.msg-s-profile-card', // class fallback (may break)
    '.msg-entity-lockup',
    // DM thread: profile header is the first artdeco-entity-lockup in the message list
    '.msg-s-message-list-content .artdeco-entity-lockup',
  ];
  let profileCard: HTMLElement | null = null;
  if (!name) {
    for (const sel of cardSelectors) {
      profileCard = document.querySelector(sel) as HTMLElement | null;
      if (profileCard) {
        console.log(tag(), 'DM: profile card via selector:', sel);
        break;
      }
    }
  }

  if (profileCard) {
    const links = Array.from(
      profileCard.querySelectorAll('a[href*="/in/"]'),
    ) as HTMLAnchorElement[];
    // Use 'img' only (not 'img, svg') — name links legitimately contain badge SVGs
    const nameLink = links.find((a) => !a.querySelector('img')) ?? null;
    if (nameLink) {
      name = nameLink.textContent?.trim() ?? '';
      linkedin_url = normalizeLinkedInUrl(nameLink.href);
    }
    // [title] attribute is more stable than text content or class names;
    // skip elements inside anchors to avoid picking up link tooltip text
    for (const el of Array.from(profileCard.querySelectorAll('[title]')) as HTMLElement[]) {
      if (el.closest('a')) continue;
      const t = el.getAttribute('title') ?? '';
      if (t.length >= 5 && !t.startsWith('·') && !/^\d/.test(t) && !TITLE_NOISE.test(t)) {
        title = t;
        break;
      }
    }
    if (!title) title = extractTitleFromCard(profileCard);
  }

  // Strategy 2: walk up from composer looking for a profile link context
  if (!name) {
    let n: HTMLElement | null = composerContainer?.parentElement ?? null;
    while (n && n !== document.body && n !== document.documentElement) {
      // img-free profile link = recipient name; allow badge SVGs
      const links = Array.from(n.querySelectorAll('a[href*="/in/"]')) as HTMLAnchorElement[];
      const nameLink = links.find((a) => !a.querySelector('img'));
      if (nameLink) {
        name = nameLink.textContent?.trim() ?? '';
        linkedin_url = normalizeLinkedInUrl(nameLink.href);
        if (!title) {
          // Narrow to the profile card within n to avoid picking up message body text
          const pcEl = (n.querySelector('.msg-s-profile-card') ??
            n.querySelector(
              '.msg-s-message-list-content .artdeco-entity-lockup',
            )) as HTMLElement | null;
          title = extractTitleFromCard(pcEl ?? n);
        }
        console.log(tag(), 'DM: name found walking up from composer');
        break;
      }
      const headerLink = n.querySelector('header a[href*="/in/"]') as HTMLAnchorElement | null;
      if (headerLink) {
        name = headerLink.textContent?.trim() ?? '';
        linkedin_url = normalizeLinkedInUrl(headerLink.href);
        break;
      }
      n = n.parentElement;
    }
  }

  // Strategy 3: loose structural selectors as last resort
  if (!name) {
    const candidates = [
      document.querySelector('a[href*="/in/"]:not(:has(img)):not(:has(svg))'),
    ] as (HTMLAnchorElement | null)[];
    for (const c of candidates) {
      if (!c) continue;
      const text = c.textContent?.trim() ?? '';
      if (text.length > 1) {
        name = text;
        linkedin_url = normalizeLinkedInUrl(c.href);
        console.log(tag(), 'DM: name from loose selector');
        break;
      }
    }
  }

  console.log(tag(), 'captured (direct message):', {
    name,
    title,
    linkedin_url,
    message_text: messageText,
  });
  if (!name) console.warn(tag(), 'Direct message: could not find recipient name');

  const debugMode = await getDebugMode();
  const debugAnchor = button ?? composer ?? (document.body as HTMLElement);
  const debug = debugMode
    ? buildDebugPayload(debugAnchor, findDebugContainer(debugAnchor))
    : undefined;

  if (isDuplicate(name)) return;
  recordSent(name);

  const event: PipelineEvent = {
    api_key: '',
    event_type: 'direct_message',
    date: new Date().toISOString().slice(0, 10),
    name,
    title,
    linkedin_url,
    page_url: window.location.href,
    message_text: messageText,
    ...(debug ? { debug } : {}),
  };

  await sendEvent(event);
}

// =============================================================================
// Click + keydown listeners
// =============================================================================

document.body.addEventListener(
  'click',
  (e: MouseEvent) => {
    const path = e.composedPath() as HTMLElement[];
    const debug = isDebugModeSync();

    // Per-click composedPath + elementsFromPoint snapshot. Only emit when debug
    // mode is on — these fire on every click and dominate the console.
    if (debug) {
      const anyEl = path.find((el) => el.getAttribute?.('aria-label')) ?? null;
      const anyBtn = (path.find((el) => el.tagName === 'BUTTON') as HTMLElement | null) ?? null;
      const anyA =
        (path.find(
          (el) => el.tagName === 'A' && el.getAttribute?.('aria-label'),
        ) as HTMLElement | null) ?? null;
      const atPoint = (document.elementsFromPoint(e.clientX, e.clientY) as HTMLElement[])
        .slice(0, 5)
        .map((el) => {
          const a = el.getAttribute('aria-label');
          return `${el.tagName}${a ? '[' + a.slice(0, 30) + ']' : ''}`;
        })
        .join(' → ');
      console.log(
        tag(),
        'click target:',
        (e.target as HTMLElement).tagName,
        '\n  path [aria-label]:',
        anyEl?.tagName,
        anyEl?.getAttribute('aria-label'),
        '\n  path button:',
        anyBtn?.getAttribute('aria-label') ?? anyBtn?.textContent?.trim().slice(0, 40),
        '\n  path a:',
        anyA?.getAttribute('aria-label'),
        '\n  at point:',
        atPoint,
      );
    }

    // Card preview: log full extraction for any click within an invitation card
    // (fires without committing to Accept, so you can verify before clicking the button)
    const nearestCard = findNearestInvitationCard(e.target as HTMLElement);
    if (nearestCard) logCardPreview(nearestCard);

    // Messaging preview: when the click lands inside the message composer,
    // log what would be captured if the user pressed Send right now. Debug-only
    // — fires on every text-box click, which is too noisy for production use.
    if (debug) {
      const ce = path.find(
        (n) => (n as HTMLElement).getAttribute?.('contenteditable') === 'true',
      ) as HTMLElement | null;
      if (ce && ce.closest('form, [class*="msg-form"]')) {
        const chat = ChatOverlayCard.fromComposer(ce);
        const page = chat ? null : MessengerPageCard.fromDocument();
        const src = chat ? 'ChatOverlayCard' : page ? 'MessengerPageCard' : 'none';
        console.log(tag(), 'messaging composer focus — preview:', {
          source: src,
          name: chat?.name ?? page?.name ?? '(not found)',
          title: chat?.title ?? page?.title ?? '(not found)',
          linkedin_url: chat?.profileUrl ?? page?.profileUrl ?? '(not found)',
          message_text: ce.textContent?.trim() || '(empty)',
        });
      }
    }

    // Find most-specific button or role=button or aria-labelled anchor in the composed path
    const el =
      (path.find(
        (n) =>
          n.tagName === 'BUTTON' ||
          n.getAttribute?.('role') === 'button' ||
          (n.tagName === 'A' && n.getAttribute?.('aria-label')),
      ) as HTMLElement | null) ?? null;

    // --- Accept invitation / connection ---
    // Primary path: button found in composed path
    if (el) {
      const ariaLabel = el.getAttribute('aria-label') ?? '';
      const elText = el.textContent?.trim() ?? '';
      const labelLower = ariaLabel.toLowerCase();
      const isAcceptInvite =
        (labelLower.includes('accept') &&
          (labelLower.includes('invit') ||
            labelLower.includes('request') ||
            labelLower.includes('connect'))) ||
        (elText.toLowerCase() === 'accept' && !!el.closest('[role="listitem"], li'));

      if (isAcceptInvite) {
        handleAcceptConnection(el).catch((err) =>
          console.warn(tag(), 'handleAcceptConnection error:', err),
        );
        return;
      }
    }

    // Fallback: click landed on a wrapper div (LinkedIn's display:contents wrappers mean the
    // button never appears in composedPath). Use elementsFromPoint to find what's actually
    // stacked under the cursor regardless of DOM position. Scoped to clicks near an actual
    // invitation card — running this on every page click (e.g. inside the messenger) is
    // wasted work since elementsFromPoint will never find an Accept button there.
    if (nearestCard) {
      const hitAccept = findAcceptButtonAtPoint(e.clientX, e.clientY);
      if (hitAccept) {
        handleAcceptConnection(hitAccept).catch((err) =>
          console.warn(tag(), 'handleAcceptConnection error:', err),
        );
        return;
      }
    }

    if (!el) return; // no further flows to check

    const ariaLabel = el.getAttribute('aria-label') ?? '';
    const elText = el.textContent?.trim() ?? '';

    // --- Sales Navigator connection request (separate linkedin.com/sales/ surface) ---
    if (isSalesNavPage()) {
      // Stage on a "Connect" menu/header item (button text only — no aria-label).
      if (el.tagName === 'BUTTON' && /^connect$/i.test(elText)) {
        stageSalesNavConnect(el);
        return;
      }
      // Send on the modal's "Send Invitation" button — identified by its stable
      // class, or by text inside the connect dialog (it carries no aria-label).
      const isSalesNavSend =
        el.tagName === 'BUTTON' &&
        (el.classList.contains('connect-cta-form__send') ||
          (/^send\s+invitation$/i.test(elText) && !!el.closest('[role="dialog"]')));
      if (isSalesNavSend) {
        const pending = readPendingConnection();
        handleSalesNavConnectionRequest(
          el,
          pending?.name,
          pending?.title,
          pending?.profileUrl,
        ).catch((err) => console.warn(tag(), 'handleSalesNavConnectionRequest error:', err));
        _pendingConnection = null;
        return;
      }
    }

    // Flow 1 staging: "Invite [Name] to connect" link
    // Mirrors linkedin-tracker exactly: try ConnectionSearchCard (search page) then
    // ProfilePageCard (profile page sidebar), fall back to empty strings.
    const inviteMatch = ariaLabel.match(/^Invite (.+) to connect$/i);
    if (inviteMatch) {
      const searchCard = ConnectionSearchCard.fromConnectLink(el);
      const profileCard = searchCard === null ? ProfilePageCard.fromConnectLink(el) : null;
      const linkedCard = searchCard ?? profileCard;
      _pendingConnection = {
        name: inviteMatch[1].trim(),
        title: linkedCard?.title ?? '',
        profileUrl: linkedCard?.profileUrl ?? '',
        ts: Date.now(),
      };
      console.log(tag(), 'captured (connect click):', {
        name: _pendingConnection.name,
        title: _pendingConnection.title,
        profile_url: _pendingConnection.profileUrl,
      });
      return;
    }

    // Flow 1 send: modal send buttons — several known variants + loose regex fallback
    const isSendInvite =
      ariaLabel === 'Send without a note' ||
      ariaLabel === 'Send invitation' ||
      ariaLabel === 'Send invite' ||
      ariaLabel.startsWith('Send invite to ') ||
      /^send\s+invit/i.test(ariaLabel);

    if (isSendInvite) {
      const pending = readPendingConnection();
      console.log(tag(), 'sending (send button):', {
        name: pending?.name,
        title: pending?.title,
        profile_url: pending?.profileUrl,
        button: ariaLabel,
      });
      handleConnectionRequest(el, pending?.name, pending?.title, pending?.profileUrl).catch((err) =>
        console.warn(tag(), 'handleConnectionRequest error:', err),
      );
      _pendingConnection = null;
      return;
    }

    // DM send button
    const sendForm = el.closest('form') ?? el.closest('[class*="msg-form"]');
    const isDmSend =
      /^send\s+message$/i.test(ariaLabel) ||
      (el.tagName === 'BUTTON' &&
        elText === 'Send' &&
        !!sendForm?.querySelector('[contenteditable]'));

    if (isDmSend) {
      handleDirectMessage(el).catch((err) =>
        console.warn(tag(), 'handleDirectMessage error:', err),
      );
      return;
    }
  },
  { capture: true },
);

document.body.addEventListener(
  'keydown',
  (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;

    // Prefer e.target (set by browser, survives focus jitter during the event);
    // fall back to document.activeElement when target is empty (synthetic events).
    const target =
      (e.target as HTMLElement | null) ?? (document.activeElement as HTMLElement | null);
    if (!target) return;

    // The composer may be the target itself or a contenteditable ancestor.
    const composer =
      target.getAttribute?.('contenteditable') === 'true'
        ? target
        : (target.closest('[contenteditable="true"]') as HTMLElement | null);
    if (!composer) return;

    // Must be inside a messaging form — guards against contenteditables on
    // other LinkedIn surfaces (e.g. post composer).
    if (!composer.closest('form, [class*="msg-form"]')) return;

    if (isDebugModeSync()) {
      console.log(tag(), 'keydown Enter → triggering DM send', {
        target_tag: target.tagName,
        composer_role: composer.getAttribute('role'),
      });
    }
    handleDirectMessage(null).catch((err) =>
      console.warn(tag(), 'handleDirectMessage error:', err),
    );
  },
  { capture: true },
);

void replayRescueBuffer();
console.log(tag(), 'content script loaded');
