import { STORAGE_KEYS, type DebugPayload, type TrackerEvent } from './types.ts';

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

export async function handleConnectionRequest(
  el: HTMLElement,
  pendingName?: string,
  pendingTitle?: string,
): Promise<void> {
  console.log('[LinkedIn Tracker] handleConnectionRequest called, pendingName:', pendingName);
  const modal = el.closest('[role="dialog"]') as HTMLElement | null;

  let name = pendingName ?? '';
  const ariaLabel = el.getAttribute('aria-label') ?? '';

  // "Invite [Name] to connect" — name is in the aria-label itself
  if (!name) {
    const inviteToConnect = ariaLabel.match(/^Invite (.+) to connect$/);
    if (inviteToConnect) name = inviteToConnect[1].trim();
  }
  // "Send invite to [Name]" modal button
  if (!name) {
    const inviteMatch = ariaLabel.match(/^Send invite to (.+)$/);
    if (inviteMatch) name = inviteMatch[1].trim();
  }
  // Fall back to scanning the modal for a labelled invite button
  if (!name) {
    const inviteBtn = modal?.querySelector('[aria-label^="Send invite to "]') as HTMLElement | null;
    const btnLabel = inviteBtn?.getAttribute('aria-label') ?? '';
    const m = btnLabel.match(/^Send invite to (.+)$/);
    if (m) name = m[1].trim();
  }
  // Last resort: modal heading
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

  const scrapeFailed = !name || !title;
  if (!name) {
    console.warn('[LinkedIn Tracker] Connection request: could not find name in modal');
  }

  const debugMode = await getDebugMode();
  let debug: DebugPayload | undefined;
  if (debugMode && scrapeFailed) {
    debug = buildDebugPayload(el, modal);
  }

  if (isDuplicate(name)) return;
  recordSent(name);

  const event: TrackerEvent = {
    api_key: '',
    date: new Date().toISOString().slice(0, 10),
    name,
    title,
    company: '',
    message_type: 'Connection Request',
    // TODO: capture note text in V2 (separate <textarea> in note composer)
    message_text: '',
    status: 'Sent',
    ...(debug ? { debug } : {}),
  };

  console.log('[LinkedIn Tracker] sending event:', JSON.stringify(event));
  try {
    chrome.runtime.sendMessage(event);
    console.log('[LinkedIn Tracker] sendMessage called successfully');
  } catch (err) {
    console.warn('[LinkedIn Tracker] sendMessage failed:', err);
  }
}

export async function handleDirectMessage(button: HTMLElement | null): Promise<void> {
  const composer = (document.querySelector('.msg-form__contenteditable[contenteditable]') ??
    document.querySelector('[data-artdeco-is-focused][contenteditable]') ??
    (document.activeElement?.getAttribute('contenteditable') === 'true'
      ? document.activeElement
      : null)) as HTMLElement | null;
  const messageText = composer?.textContent?.trim() ?? '';

  const nameEl = (document.querySelector('.msg-entity-lockup__entity-title') ??
    document.querySelector('.msg-conversation-listitem__participant-names')) as HTMLElement | null;
  const name = nameEl?.textContent?.trim() ?? '';

  const titleEl = document.querySelector('.msg-entity-lockup__subtitle') as HTMLElement | null;
  const title = titleEl?.textContent?.trim() ?? '';

  const scrapeFailed = !name;
  if (!name) {
    console.warn('[LinkedIn Tracker] Direct message: could not find recipient name');
  }

  const debugMode = await getDebugMode();
  let debug: DebugPayload | undefined;
  if (debugMode && scrapeFailed) {
    const container = (button?.closest('.msg-convo-wrapper') ??
      button?.closest('[role="main"]')) as HTMLElement | null;
    debug = buildDebugPayload(button ?? (document.body as HTMLElement), container);
  }

  if (isDuplicate(name)) return;
  recordSent(name);

  const event: TrackerEvent = {
    api_key: '',
    date: new Date().toISOString().slice(0, 10),
    name,
    title,
    company: '',
    message_type: 'Direct Message',
    message_text: messageText,
    status: 'Sent',
    ...(debug ? { debug } : {}),
  };

  try {
    chrome.runtime.sendMessage(event);
  } catch (err) {
    console.warn('[LinkedIn Tracker] sendMessage failed:', err);
  }
}

// Name and title stored from the "Invite [Name] to connect" link click.
// The link opens a modal — we wait for the modal's actual send button before logging.
let _pendingConnectionName: string | null = null;
let _pendingConnectionTitle: string | null = null;

document.body.addEventListener(
  'click',
  (e: MouseEvent) => {
    // Use composedPath() so clicks inside LinkedIn's Shadow DOM modals are visible
    const path = e.composedPath() as HTMLElement[];

    // DEBUG: log every click with full composed path info
    const anyEl = path.find((el) => el.getAttribute?.('aria-label')) ?? null;
    const anyBtn = (path.find((el) => el.tagName === 'BUTTON') as HTMLElement | null) ?? null;
    const anyA =
      (path.find(
        (el) => el.tagName === 'A' && el.getAttribute?.('aria-label'),
      ) as HTMLElement | null) ?? null;
    console.log(
      '[LinkedIn Tracker] click target:',
      (e.target as HTMLElement).tagName,
      '\n  path [aria-label]:',
      anyEl?.tagName,
      anyEl?.getAttribute('aria-label'),
      '\n  path button:',
      anyBtn?.getAttribute('aria-label') ?? anyBtn?.textContent?.trim().slice(0, 40),
      '\n  path a:',
      anyA?.getAttribute('aria-label'),
    );

    // Match the first button or aria-labelled anchor in the composed path
    const el =
      (path.find(
        (node) =>
          node.tagName === 'BUTTON' || (node.tagName === 'A' && node.getAttribute?.('aria-label')),
      ) as HTMLElement | null) ?? null;
    if (!el) return;

    const ariaLabel = el.getAttribute('aria-label') ?? '';

    // "Invite [Name] to connect" link — opens the invite modal, does not send yet.
    // Store the name so the modal send button can use it.
    const inviteToConnect = ariaLabel.match(/^Invite (.+) to connect$/);
    if (inviteToConnect) {
      _pendingConnectionName = inviteToConnect[1].trim();
      // Capture headline from profile card surrounding the connect link
      const card = el.closest(
        'li, [data-view-name], .entity-result, .artdeco-entity-lockup',
      ) as HTMLElement | null;
      const subtitleEl = card?.querySelector(
        '.entity-result__primary-subtitle, .artdeco-entity-lockup__subtitle, .pv-text-details__left-panel div',
      ) as HTMLElement | null;
      _pendingConnectionTitle = subtitleEl?.textContent?.trim() ?? null;
      console.log(
        '[LinkedIn Tracker] connect modal opened for:',
        _pendingConnectionName,
        '| title:',
        _pendingConnectionTitle,
      );
      return;
    }

    // "Send without a note" — primary send button in the invite modal
    // "Send invitation" — send button after clicking "Add a note" in the modal
    // "Send invite" / "Send invite to [Name]" — fallback for other modal variants
    if (
      ariaLabel === 'Send without a note' ||
      ariaLabel === 'Send invitation' ||
      ariaLabel === 'Send invite' ||
      ariaLabel.startsWith('Send invite to ')
    ) {
      console.log(
        '[LinkedIn Tracker] connection send matched:',
        ariaLabel,
        '| pending name:',
        _pendingConnectionName,
        '| pending title:',
        _pendingConnectionTitle,
      );
      handleConnectionRequest(
        el,
        _pendingConnectionName ?? undefined,
        _pendingConnectionTitle ?? undefined,
      ).catch((err) => console.warn('[LinkedIn Tracker] handleConnectionRequest error:', err));
      _pendingConnectionName = null;
      _pendingConnectionTitle = null;
      return;
    }

    if (ariaLabel === 'Send message') {
      handleDirectMessage(el).catch((err) =>
        console.warn('[LinkedIn Tracker] handleDirectMessage error:', err),
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
    if (!active.classList.contains('msg-form__contenteditable') && !active.closest('.msg-form'))
      return;

    handleDirectMessage(null).catch((err) =>
      console.warn('[LinkedIn Tracker] handleDirectMessage error:', err),
    );
  },
  { capture: true },
);

console.log('[LinkedIn Tracker] content script loaded');
