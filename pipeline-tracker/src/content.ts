import { STORAGE_KEYS, type DebugPayload, type PipelineEvent } from './types.ts';

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

// --- Deduplication (same 500 ms guard as existing tracker) ---
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

// --- Send helper ---
function sendEvent(event: PipelineEvent): void {
  try {
    chrome.runtime.sendMessage(event);
    console.log('[Pipeline Tracker] sendMessage called successfully');
  } catch (err) {
    console.warn('[Pipeline Tracker] sendMessage failed:', err);
  }
}

// --- Staging for Flow 1 ---
let _pendingConnectionName: string | null = null;
let _pendingConnectionTitle: string | null = null;
let _pendingConnectionProfileUrl: string | null = null;

// --- Flow 1: Outbound connection request ---
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

  if (!name) {
    const m = ariaLabel.match(/^Send invite to (.+)$/);
    if (m) name = m[1].trim();
  }
  if (!name) {
    const inviteBtn = modal?.querySelector('[aria-label^="Send invite to "]') as HTMLElement | null;
    const m = inviteBtn?.getAttribute('aria-label')?.match(/^Send invite to (.+)$/);
    if (m) name = m[1].trim();
  }
  if (!name) {
    const heading = modal?.querySelector('h2, h3') as HTMLElement | null;
    name = heading?.textContent?.trim() ?? '';
  }

  let title = pendingTitle ?? '';
  if (!title) {
    const subtitleEl = modal?.querySelector(
      '.artdeco-entity-lockup__subtitle, .artdeco-entity-lockup__metadata',
    ) as HTMLElement | null;
    title = subtitleEl?.textContent?.trim() ?? '';
  }

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

// --- Flow 2: Incoming acceptance — My Network page ---
async function handleAcceptFromNetwork(button: HTMLElement): Promise<void> {
  const ariaLabel = button.getAttribute('aria-label') ?? '';
  // Handle both straight (U+0027) and curly (U+2019) apostrophes
  const m = ariaLabel.match(/^Accept (.+)['’]s invitation$/);
  if (!m) {
    console.warn('[Pipeline Tracker] Flow 2: aria-label did not match pattern:', JSON.stringify(ariaLabel));
    return;
  }
  const name = m[1].trim();
  console.log('[Pipeline Tracker] Flow 2: matched name=', name);

  // Walk up to [role="listitem"] ancestor
  let listitem: HTMLElement | null = button.parentElement;
  let depth = 0;
  while (listitem && listitem.getAttribute('role') !== 'listitem') {
    listitem = listitem.parentElement;
    depth++;
  }
  console.log('[Pipeline Tracker] Flow 2: listitem found=', !!listitem, 'depth=', depth, 'tag=', listitem?.tagName);

  const profileAnchor = listitem?.querySelector('a[href*="/in/"]') as HTMLAnchorElement | null;
  const rawUrl = profileAnchor?.href ?? '';
  const linkedin_url = normalizeLinkedInUrl(rawUrl);
  console.log('[Pipeline Tracker] Flow 2: profile anchor found=', !!profileAnchor, 'rawUrl=', rawUrl, 'normalized=', linkedin_url);

  // Title: longest span ≥ 20 chars, no <a> ancestor, not starting with digit
  let title = '';
  if (listitem) {
    const spans = Array.from(listitem.querySelectorAll('span')) as HTMLSpanElement[];
    const candidates = spans.filter((s) => {
      if (s.closest('a')) return false;
      const t = s.textContent?.trim() ?? '';
      return t.length >= 20 && !/^\d/.test(t);
    });
    console.log(
      '[Pipeline Tracker] Flow 2: title candidates=',
      candidates.map((s) => s.textContent?.trim().slice(0, 80)),
    );
    title = candidates.reduce((best, s) => {
      const t = s.textContent?.trim() ?? '';
      return t.length > best.length ? t : best;
    }, '');
  }

  console.log('[Pipeline Tracker] Flow 2: extracted title=', title);
  if (!title) console.warn('[Pipeline Tracker] Flow 2: could not find title');

  const messageText =
    (listitem
      ?.querySelector('[data-testid="expandable-text-box"]')
      ?.textContent?.trim()) ?? '';
  console.log('[Pipeline Tracker] Flow 2: message_text=', messageText || '(empty)');

  const scrapeFailed = !title;
  const debugMode = await getDebugMode();
  const debug = debugMode && scrapeFailed ? buildDebugPayload(button, listitem) : undefined;

  if (isDuplicate(name)) return;
  recordSent(name);

  console.log('[Pipeline Tracker] captured (accept click):', { name, title, linkedin_url, message_text: messageText });

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

// --- Flow 3: Incoming acceptance — Profile page ---
async function handleAcceptFromProfile(button: HTMLElement): Promise<void> {
  const ariaLabel = button.getAttribute('aria-label') ?? '';
  // Handle both straight (U+0027) and curly (U+2019) apostrophes
  const m = ariaLabel.match(/^Accept (.+)['']s request to connect$/);
  if (!m) {
    console.warn('[Pipeline Tracker] Flow 3: aria-label did not match pattern:', JSON.stringify(ariaLabel));
    return;
  }
  const name = m[1].trim();
  console.log('[Pipeline Tracker] Flow 3: matched name=', name);

  // Walk up to find ancestor containing both <h2> and a[href*="/in/"]
  let topcard: HTMLElement | null = button.parentElement;
  let depth = 0;
  while (topcard && topcard !== document.body) {
    if (topcard.querySelector('h2') && topcard.querySelector('a[href*="/in/"]')) break;
    topcard = topcard.parentElement;
    depth++;
  }
  console.log('[Pipeline Tracker] Flow 3: topcard found=', !!topcard, 'depth=', depth, 'tag=', topcard?.tagName);

  const profileAnchor = topcard?.querySelector('a[href*="/in/"]') as HTMLAnchorElement | null;
  const rawUrl = profileAnchor?.href ?? '';
  const linkedin_url = normalizeLinkedInUrl(rawUrl);
  console.log('[Pipeline Tracker] Flow 3: profile anchor found=', !!profileAnchor, 'rawUrl=', rawUrl, 'normalized=', linkedin_url);

  // Title: first <p> in topcard not inside an <a>, text ≥ 20 chars
  let title = '';
  if (topcard) {
    const paras = Array.from(topcard.querySelectorAll('p')) as HTMLParagraphElement[];
    const candidates = paras.filter((p) => {
      if (p.closest('a')) return false;
      return (p.textContent?.trim() ?? '').length >= 20;
    });
    console.log(
      '[Pipeline Tracker] Flow 3: title candidates=',
      candidates.map((p) => p.textContent?.trim().slice(0, 80)),
    );
    title = candidates[0]?.textContent?.trim() ?? '';
  }

  console.log('[Pipeline Tracker] Flow 3: extracted title=', title);
  if (!title) console.warn('[Pipeline Tracker] Flow 3: could not find title');

  const scrapeFailed = !title;
  const debugMode = await getDebugMode();
  const debug =
    debugMode && scrapeFailed ? buildDebugPayload(button, topcard) : undefined;

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
    message_text: '',
    ...(debug ? { debug } : {}),
  };

  sendEvent(event);
}

// --- Flow: Direct message ---
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
    document.querySelector('.msg-form__contenteditable[contenteditable]') ??
    document.querySelector('[data-artdeco-is-focused][contenteditable]') ??
    (document.activeElement?.getAttribute('contenteditable') === 'true'
      ? document.activeElement
      : null)) as HTMLElement | null;
  const messageText = composer?.textContent?.trim() ?? '';

  let name = '';
  let linkedin_url = '';
  let title = '';

  // Full messenger page: profile card lives outside the compose chain
  const profileCard = document.querySelector('.msg-s-profile-card') as HTMLElement | null;
  if (profileCard) {
    const links = Array.from(
      profileCard.querySelectorAll('a[href*="/in/"]'),
    ) as HTMLAnchorElement[];
    const nameLink = links.find((a) => !a.querySelector('img')) ?? null;
    if (nameLink) {
      name = nameLink.textContent?.trim() ?? '';
      linkedin_url = normalizeLinkedInUrl(nameLink.href);
    }
    // Title from [title] attribute on entity lockup elements
    for (const el of Array.from(
      profileCard.querySelectorAll('div[title], span[title]'),
    ) as HTMLElement[]) {
      const t = el.getAttribute('title') ?? '';
      if (t.length >= 5 && !t.startsWith('·') && !/^\d/.test(t)) {
        title = t;
        break;
      }
    }
  }

  // Walk up from composer looking for a profile link (overlay / mini-messenger)
  if (!name) {
    let n: HTMLElement | null = composerContainer?.parentElement ?? null;
    while (n && n !== document.body && n !== document.documentElement) {
      const imgs = Array.from(n.querySelectorAll('img')) as HTMLImageElement[];
      const img =
        imgs.find((i) => !i.closest('.msg-s-event-listitem, .msg-s-message-list__event')) ?? null;
      if (img) {
        let lockup: HTMLElement | null = img.parentElement;
        while (lockup && lockup !== n) {
          if (lockup.querySelector('a[href*="/in/"]')) {
            const links = Array.from(
              lockup.querySelectorAll('a[href*="/in/"]'),
            ) as HTMLAnchorElement[];
            const profileLink = links.find((a) => !a.querySelector('img')) ?? null;
            if (profileLink) {
              name = profileLink.textContent?.trim() ?? '';
              linkedin_url = normalizeLinkedInUrl(profileLink.href);
              for (const el of Array.from(
                lockup.querySelectorAll('div[title], span[title]'),
              ) as HTMLElement[]) {
                const t = el.getAttribute('title') ?? '';
                if (t.length >= 5 && !t.startsWith('·') && !/^\d/.test(t)) {
                  title = t;
                  break;
                }
              }
            }
            break;
          }
          lockup = lockup.parentElement;
        }
        if (name) break;
      }
      // Header link fallback (overlay popup with no visible picture)
      const headerLink = n.querySelector('header a[href*="/in/"]') as HTMLAnchorElement | null;
      if (headerLink) {
        name = headerLink.textContent?.trim() ?? '';
        linkedin_url = normalizeLinkedInUrl(headerLink.href);
        break;
      }
      n = n.parentElement;
    }
  }

  // Class-based fallback
  if (!name) {
    const nameEl = (document.querySelector('.msg-entity-lockup__entity-title') ??
      document.querySelector('.msg-conversation-listitem__participant-names') ??
      document.querySelector('.msg-overlay-bubble-header__title a')) as HTMLElement | null;
    name = nameEl?.textContent?.trim() ?? '';
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
          (button?.closest('.msg-convo-wrapper') ??
            button?.closest('[role="main"]')) as HTMLElement | null,
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

// --- Click listener ---
document.body.addEventListener(
  'click',
  (e: MouseEvent) => {
    const path = e.composedPath() as HTMLElement[];

    // Log every click with composed path info (mirrors existing tracker pattern)
    const anyEl = path.find((el) => el.getAttribute?.('aria-label')) ?? null;
    const anyBtn = (path.find((el) => el.tagName === 'BUTTON') as HTMLElement | null) ?? null;
    const anyA =
      (path.find(
        (el) => el.tagName === 'A' && el.getAttribute?.('aria-label'),
      ) as HTMLElement | null) ?? null;
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
    );

    const el =
      (path.find(
        (n) =>
          n.tagName === 'BUTTON' || (n.tagName === 'A' && n.getAttribute?.('aria-label')),
      ) as HTMLElement | null) ?? null;
    if (!el) return;

    const ariaLabel = el.getAttribute('aria-label') ?? '';

    // Flow 2: Accept from My Network page
    if (/^Accept .+['']s invitation$/.test(ariaLabel)) {
      handleAcceptFromNetwork(el).catch((err) =>
        console.warn('[Pipeline Tracker] handleAcceptFromNetwork error:', err),
      );
      return;
    }

    // Flow 3: Accept from profile page
    if (/^Accept .+['']s request to connect$/.test(ariaLabel)) {
      handleAcceptFromProfile(el).catch((err) =>
        console.warn('[Pipeline Tracker] handleAcceptFromProfile error:', err),
      );
      return;
    }

    // Flow 1 staging: "Invite [Name] to connect"
    const inviteToConnect = ariaLabel.match(/^Invite (.+) to connect$/);
    if (inviteToConnect) {
      _pendingConnectionName = inviteToConnect[1].trim();
      _pendingConnectionTitle = '';
      _pendingConnectionProfileUrl = '';

      // Walk up to find card with a /in/ profile link
      let card: HTMLElement | null = el.parentElement;
      while (card && card !== document.body) {
        const profileLink = card.querySelector('a[href*="/in/"]') as HTMLAnchorElement | null;
        if (profileLink) {
          _pendingConnectionProfileUrl = normalizeLinkedInUrl(profileLink.href);
          const subtitleEl = card.querySelector(
            '.artdeco-entity-lockup__subtitle, .entity-result__primary-subtitle',
          ) as HTMLElement | null;
          _pendingConnectionTitle = subtitleEl?.textContent?.trim() ?? '';
          break;
        }
        card = card.parentElement;
      }

      console.log('[Pipeline Tracker] captured (connect click):', {
        name: _pendingConnectionName,
        title: _pendingConnectionTitle,
        profile_url: _pendingConnectionProfileUrl,
      });
      return;
    }

    // Flow 1 send: modal send buttons
    if (
      ariaLabel === 'Send without a note' ||
      ariaLabel === 'Send invitation' ||
      ariaLabel === 'Send invite' ||
      ariaLabel.startsWith('Send invite to ')
    ) {
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
    const sendForm = el.closest('form') ?? el.closest('.msg-form');
    if (
      ariaLabel === 'Send message' ||
      (el.tagName === 'BUTTON' &&
        el.textContent?.trim() === 'Send' &&
        !!sendForm?.querySelector('[contenteditable]'))
    ) {
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
    if (e.key !== 'Enter' || e.shiftKey) return;
    const active = document.activeElement as HTMLElement | null;
    if (active?.getAttribute('contenteditable') !== 'true') return;
    if (!active.closest('form, .msg-form')) return;
    handleDirectMessage(null).catch((err) =>
      console.warn('[Pipeline Tracker] handleDirectMessage error:', err),
    );
  },
  { capture: true },
);

console.log('[Pipeline Tracker] content script loaded');
