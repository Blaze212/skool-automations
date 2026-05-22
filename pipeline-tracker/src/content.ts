import { STORAGE_KEYS, type DebugPayload, type PipelineEvent } from './types.ts';
import { ConnectionSearchCard } from '../../linkedin-tracker/src/connection-search-card.ts';
import { ProfilePageCard } from '../../linkedin-tracker/src/profile-page-card.ts';
import { AcceptInvitationCard } from './accept-invitation-card.ts';
import { ProfilePageAcceptCard } from './profile-page-accept-card.ts';
import { ChatOverlayCard } from './chat-overlay-card.ts';
import { MessengerPageCard } from './messenger-page-card.ts';

export { AcceptInvitationCard };
export { ProfilePageAcceptCard };
export { ChatOverlayCard };
export { MessengerPageCard };

// --- LinkedIn URL normalization ---
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

function buildDebugPayload(button: HTMLElement, container: HTMLElement | null): DebugPayload {
  return {
    button_aria_label: button.getAttribute('aria-label') ?? '',
    button_text: button.textContent?.trim() ?? '',
    container_html: (container?.outerHTML ?? '').substring(0, 10000),
    page_url: window.location.href,
  };
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
    '[Pipeline Tracker] name candidates:',
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
    '[Pipeline Tracker] title candidates:',
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
  console.log('[Pipeline Tracker] ── CARD PREVIEW ──────────────────────────');
  const name = extractNameFromCard(card);
  const title = extractTitleFromCard(card);
  const linkedin_url = extractProfileUrlFromCard(card);
  const messageText =
    card.querySelector('[data-testid="expandable-text-box"]')?.textContent?.trim() ?? '';
  console.log('[Pipeline Tracker] PREVIEW result:', {
    name: name || '(not found)',
    title: title || '(not found)',
    linkedin_url: linkedin_url || '(not found)',
    message_text: messageText || '(empty)',
  });
  console.log('[Pipeline Tracker] ─────────────────────────────────────────');
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
      '[Pipeline Tracker] elementsFromPoint:',
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
        '[Pipeline Tracker] accept: direct hit via elementsFromPoint, label=',
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
            '[Pipeline Tracker] accept: ancestor hit via elementsFromPoint, label=',
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
function sendEvent(event: PipelineEvent): void {
  try {
    chrome.runtime.sendMessage(event);
    console.log('[Pipeline Tracker] sendMessage called successfully');
  } catch (err) {
    console.warn('[Pipeline Tracker] sendMessage failed:', err);
  }
}

// =============================================================================
// Flow 1: Outbound connection request
// =============================================================================

let _pendingConnectionName: string | null = null;
let _pendingConnectionTitle: string | null = null;
let _pendingConnectionProfileUrl: string | null = null;

export async function handleConnectionRequest(
  el: HTMLElement,
  pendingName?: string,
  pendingTitle?: string,
  pendingProfileUrl?: string,
): Promise<void> {
  console.log('[Pipeline Tracker] handleConnectionRequest called, pendingName:', pendingName);
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
  // Heading inside the modal
  if (!name && modal) {
    const heading = modal.querySelector('h2, h3, h4') as HTMLElement | null;
    name = heading?.textContent?.trim() ?? '';
  }

  let title = pendingTitle ?? '';
  if (!title && modal) title = extractTitleFromCard(modal);

  console.log('[Pipeline Tracker] Flow 1: name=', name, 'title=', title);
  if (!name) console.warn('[Pipeline Tracker] Flow 1: could not find name in modal');

  const scrapeFailed = !name || !title;
  const debugMode = await getDebugMode();
  const debug = debugMode && scrapeFailed ? buildDebugPayload(el, modal) : undefined;

  if (isDuplicate(name)) return;
  recordSent(name);

  const event: PipelineEvent = {
    api_key: '',
    event_type: 'connection_request',
    date: new Date().toISOString().slice(0, 10),
    name,
    title,
    linkedin_url: normalizeLinkedInUrl(pendingProfileUrl ?? ''),
    page_url: window.location.href,
    message_text: '',
    ...(debug ? { debug } : {}),
  };

  console.log('[Pipeline Tracker] sending event:', JSON.stringify(event));
  sendEvent(event);
}

// =============================================================================
// Flow 2 + 3: Accept connection (My Network page OR Profile page)
// Merged into one handler — structural helpers handle both DOM shapes.
// =============================================================================

async function handleAcceptConnection(button: HTMLElement): Promise<void> {
  // My Network / invitation-manager page: button lives inside [role="listitem"]/li.
  // Profile page (where Connect normally sits): no listitem ancestor — use the
  // profile header section, anchored on /in/{vanity}/ from the URL.
  const inviteCard =
    AcceptInvitationCard.fromAcceptButton(button) ?? ProfilePageAcceptCard.fromAcceptButton(button);
  console.log(
    '[Pipeline Tracker] accept: ariaLabel=',
    JSON.stringify(button.getAttribute('aria-label') ?? ''),
    'card type=',
    inviteCard instanceof ProfilePageAcceptCard
      ? 'profile-page'
      : inviteCard
        ? 'my-network'
        : 'none',
  );

  const name = inviteCard?.name ?? '';
  const title = inviteCard?.title ?? '';
  const linkedin_url = inviteCard?.profileUrl ?? '';
  const messageText = inviteCard?.messageText ?? '';

  if (!name) console.warn('[Pipeline Tracker] accept: could not find name');
  if (!title) console.warn('[Pipeline Tracker] accept: could not find title');

  const scrapeFailed = !name || !title;
  const debugMode = await getDebugMode();
  const debug =
    debugMode && scrapeFailed
      ? buildDebugPayload(button, inviteCard?.container ?? null)
      : undefined;

  if (isDuplicate(name)) return;
  recordSent(name);

  console.log('[Pipeline Tracker] captured (accept click):', { name, title, linkedin_url });

  const event: PipelineEvent = {
    api_key: '',
    event_type: 'accepted_connection',
    date: new Date().toISOString().slice(0, 10),
    name,
    title,
    linkedin_url,
    page_url: window.location.href,
    message_text: messageText,
    ...(debug ? { debug } : {}),
  };

  sendEvent(event);
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
      console.log('[Pipeline Tracker] DM: extracted via ChatOverlayCard');
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
      console.log('[Pipeline Tracker] DM: extracted via MessengerPageCard');
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
        console.log('[Pipeline Tracker] DM: profile card via selector:', sel);
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
            n.querySelector('.msg-s-message-list-content .artdeco-entity-lockup')) as HTMLElement | null;
          title = extractTitleFromCard(pcEl ?? n);
        }
        console.log('[Pipeline Tracker] DM: name found walking up from composer');
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
        console.log('[Pipeline Tracker] DM: name from loose selector');
        break;
      }
    }
  }

  console.log('[Pipeline Tracker] captured (direct message):', {
    name,
    title,
    linkedin_url,
    message_text: messageText,
  });
  if (!name) console.warn('[Pipeline Tracker] Direct message: could not find recipient name');

  const scrapeFailed = !name;
  const debugMode = await getDebugMode();
  const debug =
    debugMode && scrapeFailed
      ? buildDebugPayload(
          button ?? (document.body as HTMLElement),
          (button?.closest('[role="main"]') ??
            document.querySelector('[role="main"]')) as HTMLElement | null,
        )
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

  sendEvent(event);
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
        '[Pipeline Tracker] click target:',
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
        console.log('[Pipeline Tracker] messaging composer focus — preview:', {
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
          console.warn('[Pipeline Tracker] handleAcceptConnection error:', err),
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
          console.warn('[Pipeline Tracker] handleAcceptConnection error:', err),
        );
        return;
      }
    }

    if (!el) return; // no further flows to check

    const ariaLabel = el.getAttribute('aria-label') ?? '';
    const elText = el.textContent?.trim() ?? '';

    // Flow 1 staging: "Invite [Name] to connect" link
    // Mirrors linkedin-tracker exactly: try ConnectionSearchCard (search page) then
    // ProfilePageCard (profile page sidebar), fall back to empty strings.
    const inviteMatch = ariaLabel.match(/^Invite (.+) to connect$/i);
    if (inviteMatch) {
      _pendingConnectionName = inviteMatch[1].trim();
      const searchCard = ConnectionSearchCard.fromConnectLink(el);
      const profileCard = searchCard === null ? ProfilePageCard.fromConnectLink(el) : null;
      const linkedCard = searchCard ?? profileCard;
      _pendingConnectionTitle = linkedCard?.title ?? '';
      _pendingConnectionProfileUrl = linkedCard?.profileUrl ?? '';
      console.log('[Pipeline Tracker] captured (connect click):', {
        name: _pendingConnectionName,
        title: _pendingConnectionTitle,
        profile_url: _pendingConnectionProfileUrl,
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
      console.log('[Pipeline Tracker] sending (send button):', {
        name: _pendingConnectionName,
        title: _pendingConnectionTitle,
        profile_url: _pendingConnectionProfileUrl,
        button: ariaLabel,
      });
      handleConnectionRequest(
        el,
        _pendingConnectionName ?? undefined,
        _pendingConnectionTitle ?? undefined,
        _pendingConnectionProfileUrl ?? undefined,
      ).catch((err) => console.warn('[Pipeline Tracker] handleConnectionRequest error:', err));
      _pendingConnectionName = null;
      _pendingConnectionTitle = null;
      _pendingConnectionProfileUrl = null;
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
        console.warn('[Pipeline Tracker] handleDirectMessage error:', err),
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
      console.log('[Pipeline Tracker] keydown Enter → triggering DM send', {
        target_tag: target.tagName,
        composer_role: composer.getAttribute('role'),
      });
    }
    handleDirectMessage(null).catch((err) =>
      console.warn('[Pipeline Tracker] handleDirectMessage error:', err),
    );
  },
  { capture: true },
);

console.log('[Pipeline Tracker] content script loaded');
