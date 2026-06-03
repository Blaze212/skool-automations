// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleConnectionRequest,
  handleSalesNavConnectionRequest,
  replayRescueBuffer,
  resetContextBanner,
  resetDedup,
  resetRescueBuffer,
} from '../../../pipeline-tracker/src/content.ts';
import {
  STORAGE_KEYS,
  type OutboxEntry,
  type PipelineEvent,
} from '../../../pipeline-tracker/src/types.ts';

interface Store {
  [key: string]: unknown;
}

function installStatefulLocalStorage(): Store {
  const local: Store = {};
  (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockImplementation(
    async (keys?: string | string[]) => {
      if (keys === undefined) return { ...local };
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Store = {};
      for (const k of list) if (k in local) out[k] = local[k];
      return out;
    },
  );
  (chrome.storage.local.set as ReturnType<typeof vi.fn>).mockImplementation(
    async (entries: Store) => {
      Object.assign(local, entries);
    },
  );
  return local;
}

function lastEnqueuedEvent(local: Store): PipelineEvent {
  const outbox = local[STORAGE_KEYS.OUTBOX] as OutboxEntry[] | undefined;
  if (!outbox || outbox.length === 0) {
    throw new Error('No outbox entry was enqueued');
  }
  return outbox[outbox.length - 1].event;
}

describe('pipeline-tracker content script — handleConnectionRequest', () => {
  let local: Store;

  beforeEach(() => {
    vi.clearAllMocks();
    resetDedup();
    resetContextBanner();
    resetRescueBuffer();
    document.body.innerHTML = '';
    local = installStatefulLocalStorage();
    (chrome.storage.sync.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      debug_mode: false,
    });
  });

  afterEach(() => {
    window.history.pushState({}, '', '/');
  });

  // Regression: on a /in/{vanity}/ profile page, clicking Connect sometimes
  // misses the button at click time (LinkedIn's display:contents wrappers can
  // drop it from composedPath). The user then clicks "Send without a note" in
  // the modal, and we used to scrape the modal's UI <h2> ("Add a note to your
  // invitation") as the recipient name and the modal body paragraph as the
  // title. The fix is to fall back to the profile page itself, anchored on
  // the URL vanity, rather than the modal.
  it('on /in/{vanity}/, scrapes owner name/title/profileUrl when modal has only UI text', async () => {
    window.history.pushState({}, '', '/in/taniahansraj/');

    // Profile page DOM — owner heading anchor + headline <p>
    const main = document.createElement('main');
    const section = document.createElement('section');
    main.appendChild(section);
    const block = document.createElement('div');
    section.appendChild(block);
    const headingAnchor = document.createElement('a');
    headingAnchor.href = 'https://www.linkedin.com/in/taniahansraj/';
    const h2 = document.createElement('h2');
    h2.textContent = 'Tania Hansraj';
    headingAnchor.appendChild(h2);
    block.appendChild(headingAnchor);
    const headlineP = document.createElement('p');
    headlineP.textContent =
      'Head of Talent at Career Systems | helping engineers land senior roles';
    block.appendChild(headlineP);
    document.body.appendChild(main);

    // LinkedIn "Add a note" modal — UI heading, generic body, no recipient lockup
    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    const modalHeading = document.createElement('h2');
    modalHeading.textContent = 'Add a note to your invitation?';
    modal.appendChild(modalHeading);
    const modalBody = document.createElement('p');
    modalBody.textContent =
      'LinkedIn members are more likely to accept invitations that include a personal note.';
    modal.appendChild(modalBody);
    const sendButton = document.createElement('button');
    sendButton.setAttribute('aria-label', 'Send without a note');
    sendButton.textContent = 'Send without a note';
    modal.appendChild(sendButton);
    document.body.appendChild(modal);

    await handleConnectionRequest(sendButton);

    const payload = lastEnqueuedEvent(local);
    expect(payload.event_type).toBe('connection_request');
    expect(payload.name).toBe('Tania Hansraj');
    expect(payload.title).toBe(
      'Head of Talent at Career Systems | helping engineers land senior roles',
    );
    expect(payload.linkedin_url).toBe('https://www.linkedin.com/in/taniahansraj');
    // Specifically must not be the modal UI text — the bug we're fixing
    expect(payload.name).not.toContain('Add a note');
    expect(payload.title).not.toContain('LinkedIn members are more likely');
  });

  // Spec 090/015 A5.2 — scoreCapture wiring. sendEvent stamps scrape_confidence
  // on the wire event AND mirrors it onto the outbox entry (with needs_review).
  it('stamps scrape_confidence=high + needs_review=false on a clean capture', async () => {
    const sendButton = document.createElement('button');
    sendButton.setAttribute('aria-label', 'Send without a note');
    document.body.appendChild(sendButton);

    await handleConnectionRequest(
      sendButton,
      'Jane Smith',
      'Staff Engineer',
      'https://www.linkedin.com/in/jane-smith/',
    );

    const payload = lastEnqueuedEvent(local);
    expect(payload.scrape_confidence).toBe('high');
    const outbox = local[STORAGE_KEYS.OUTBOX] as OutboxEntry[];
    const entry = outbox[outbox.length - 1];
    expect(entry.scrape_confidence).toBe('high');
    expect(entry.needs_review).toBe(false);
  });

  it('stamps scrape_confidence=low + needs_review=true on a degraded capture', async () => {
    const sendButton = document.createElement('button');
    sendButton.setAttribute('aria-label', 'Send without a note');
    document.body.appendChild(sendButton);

    // Junk name + non-profile URL → low confidence.
    await handleConnectionRequest(
      sendButton,
      'Connect',
      'Staff Engineer',
      'https://www.linkedin.com/feed/',
    );

    const payload = lastEnqueuedEvent(local);
    expect(payload.scrape_confidence).toBe('low');
    const outbox = local[STORAGE_KEYS.OUTBOX] as OutboxEntry[];
    const entry = outbox[outbox.length - 1];
    expect(entry.scrape_confidence).toBe('low');
    expect(entry.needs_review).toBe(true);
  });

  it('pendingName/Title/ProfileUrl take priority over profile-page scrape', async () => {
    window.history.pushState({}, '', '/in/taniahansraj/');

    // Profile page DOM with one set of values
    const main = document.createElement('main');
    const headingAnchor = document.createElement('a');
    headingAnchor.href = 'https://www.linkedin.com/in/taniahansraj/';
    const h2 = document.createElement('h2');
    h2.textContent = 'Tania Hansraj';
    headingAnchor.appendChild(h2);
    main.appendChild(headingAnchor);
    document.body.appendChild(main);

    // Caller provided pending values from the original Connect click
    const sendButton = document.createElement('button');
    sendButton.setAttribute('aria-label', 'Send without a note');
    document.body.appendChild(sendButton);

    await handleConnectionRequest(
      sendButton,
      'Pending Name',
      'Pending Title',
      'https://www.linkedin.com/in/pending-vanity/',
    );

    const payload = lastEnqueuedEvent(local);
    expect(payload.name).toBe('Pending Name');
    expect(payload.title).toBe('Pending Title');
    expect(payload.linkedin_url).toBe('https://www.linkedin.com/in/pending-vanity');
  });

  // Spec 008: when debug_mode is on, the debug payload ships on every event
  // so the webhook can run AI extraction over container_html — not only on
  // scrape failure.
  it('debug_mode=true + scrape success → debug field present (always-on for AI extraction)', async () => {
    (chrome.storage.sync.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      debug_mode: true,
    });

    // Profile page DOM so scrape succeeds
    window.history.pushState({}, '', '/in/taniahansraj/');
    const main = document.createElement('main');
    const headingAnchor = document.createElement('a');
    headingAnchor.href = 'https://www.linkedin.com/in/taniahansraj/';
    const h2 = document.createElement('h2');
    h2.textContent = 'Tania Hansraj';
    headingAnchor.appendChild(h2);
    main.appendChild(headingAnchor);
    const headlineP = document.createElement('p');
    headlineP.textContent = 'Head of Talent at Career Systems';
    main.appendChild(headlineP);
    document.body.appendChild(main);

    const sendButton = document.createElement('button');
    sendButton.setAttribute('aria-label', 'Send without a note');
    document.body.appendChild(sendButton);

    await handleConnectionRequest(sendButton);

    const payload = lastEnqueuedEvent(local);
    expect(payload.name).toBe('Tania Hansraj');
    expect(payload.title).toBe('Head of Talent at Career Systems');
    expect(payload.debug).toBeDefined();
    expect(payload.debug!.container_html.length).toBeLessThanOrEqual(50000);
    expect(payload.debug!.page_url).toContain('/in/taniahansraj/');
  });

  // Regression: when the extension context is invalidated (orphaned content
  // script after an extension/browser update), the FIRST chrome.* call on the
  // capture path is chrome.storage.local inside enqueuePendingEvent — it throws
  // before sendMessage is ever reached. The reload banner must still be shown
  // from the enqueue catch, otherwise the event is dropped silently.
  it('shows reload banner when enqueue throws "Extension context invalidated"', async () => {
    (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Extension context invalidated.'),
    );

    const sendButton = document.createElement('button');
    sendButton.setAttribute('aria-label', 'Send without a note');
    document.body.appendChild(sendButton);

    await handleConnectionRequest(sendButton, 'Pending Name');

    expect(document.getElementById('pipeline-tracker-reload-banner')).not.toBeNull();
    // sendMessage must not have been attempted — enqueue bailed first.
    expect(chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  // Regression: in real orphaned content scripts Chrome tears down chrome.storage
  // to undefined, so the enqueue throws a plain TypeError ("Cannot read
  // properties of undefined") — NOT the documented "Extension context
  // invalidated" message. Detection must key off chrome.runtime.id (which goes
  // undefined on invalidation), otherwise the banner never shows. This is the
  // exact failure the user hit in manual testing.
  it('shows reload banner when an orphaned context throws a bare TypeError', async () => {
    const runtime = chrome.runtime as { id?: string };
    const savedId = runtime.id;
    runtime.id = undefined; // simulate invalidated extension context
    (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockRejectedValue(
      new TypeError("Cannot read properties of undefined (reading 'get')"),
    );

    const sendButton = document.createElement('button');
    sendButton.setAttribute('aria-label', 'Send without a note');
    document.body.appendChild(sendButton);

    try {
      await handleConnectionRequest(sendButton, 'Pending Name');
      expect(document.getElementById('pipeline-tracker-reload-banner')).not.toBeNull();
      expect(chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    } finally {
      runtime.id = savedId;
    }
  });

  // Resilience: MV3 service workers die after ~30s idle. Chrome is supposed to
  // wake them when sendMessage is called, but the wake can race or fail — and
  // when it does, sendMessage rejects with "Could not establish connection".
  // We retry transparently so a single transient SW-wake failure doesn't drop
  // the event signal to the user.
  it('retries sendMessage when SW is unreachable and succeeds on retry', async () => {
    const sendMessage = chrome.runtime.sendMessage as ReturnType<typeof vi.fn>;
    sendMessage
      .mockRejectedValueOnce(
        new Error('Could not establish connection. Receiving end does not exist.'),
      )
      .mockResolvedValueOnce(undefined);

    const sendButton = document.createElement('button');
    sendButton.setAttribute('aria-label', 'Send without a note');
    document.body.appendChild(sendButton);

    await handleConnectionRequest(sendButton, 'Pending Name');

    expect(sendMessage).toHaveBeenCalledTimes(2);
    // Event was still enqueued — exactly once.
    expect((local[STORAGE_KEYS.OUTBOX] as OutboxEntry[]).length).toBe(1);
    // No reload banner — recovery succeeded.
    expect(document.getElementById('pipeline-tracker-reload-banner')).toBeNull();
  });

  // Resilience: when every retry fails, the plugin must FAIL LOUDLY so the user
  // knows capture isn't working — silently dropping the signal is what caused
  // the "plugin randomly dies" reports.
  it('shows reload banner when SW is unreachable on every attempt', async () => {
    const sendMessage = chrome.runtime.sendMessage as ReturnType<typeof vi.fn>;
    sendMessage.mockRejectedValue(
      new Error('Could not establish connection. Receiving end does not exist.'),
    );

    const sendButton = document.createElement('button');
    sendButton.setAttribute('aria-label', 'Send without a note');
    document.body.appendChild(sendButton);

    await handleConnectionRequest(sendButton, 'Pending Name');

    // 1 initial + 2 retries = 3 attempts.
    expect(sendMessage).toHaveBeenCalledTimes(3);
    // Event is safely in the outbox for the alarm-driven drain to pick up later.
    expect((local[STORAGE_KEYS.OUTBOX] as OutboxEntry[]).length).toBe(1);
    // Loud banner shown.
    const banner = document.getElementById('pipeline-tracker-reload-banner');
    expect(banner).not.toBeNull();
  });

  // Regression: "message port closed before a response was received" is the
  // sister-shape of "Could not establish connection" — same root cause (SW
  // died mid-request or failed to revive), different Chrome version's wording.
  it('treats "message port closed" as SW-unreachable and retries', async () => {
    const sendMessage = chrome.runtime.sendMessage as ReturnType<typeof vi.fn>;
    sendMessage
      .mockRejectedValueOnce(new Error('The message port closed before a response was received.'))
      .mockResolvedValueOnce(undefined);

    const sendButton = document.createElement('button');
    sendButton.setAttribute('aria-label', 'Send without a note');
    document.body.appendChild(sendButton);

    await handleConnectionRequest(sendButton, 'Pending Name');

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(document.getElementById('pipeline-tracker-reload-banner')).toBeNull();
  });

  // Rescue buffer: when enqueue fails due to context invalidation, the event
  // must be stashed in sessionStorage so a reload can retry it.
  it('saves event to rescue buffer on context-invalidated enqueue failure', async () => {
    (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Extension context invalidated.'),
    );

    const sendButton = document.createElement('button');
    sendButton.setAttribute('aria-label', 'Send without a note');
    document.body.appendChild(sendButton);

    await handleConnectionRequest(sendButton, 'Jane Doe', 'Staff Engineer');

    const raw = sessionStorage.getItem('pipeline_tracker_rescued_events');
    expect(raw).not.toBeNull();
    const buffered = JSON.parse(raw!) as PipelineEvent[];
    expect(buffered).toHaveLength(1);
    expect(buffered[0].name).toBe('Jane Doe');
    expect(buffered[0].event_type).toBe('connection_request');
  });

  // Rescue buffer: generic chrome.storage errors (not quota, not context) also
  // populate the buffer so a reload recovers the event.
  it('saves event to rescue buffer on generic storage enqueue failure', async () => {
    (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Unexpected IO error'),
    );

    const sendButton = document.createElement('button');
    sendButton.setAttribute('aria-label', 'Send without a note');
    document.body.appendChild(sendButton);

    await handleConnectionRequest(sendButton, 'Bob Smith');

    const raw = sessionStorage.getItem('pipeline_tracker_rescued_events');
    expect(raw).not.toBeNull();
    const buffered = JSON.parse(raw!) as PipelineEvent[];
    expect(buffered[0].name).toBe('Bob Smith');
  });

  // Rescue buffer: replayRescueBuffer re-enqueues the buffered event after reload.
  it('replayRescueBuffer enqueues rescued events and clears the buffer', async () => {
    const event: PipelineEvent = {
      api_key: '',
      event_type: 'connection_request',
      date: '2026-06-01',
      name: 'Jane Doe',
      title: 'Staff Engineer',
      linkedin_url: 'https://www.linkedin.com/in/jane-doe',
      page_url: 'https://www.linkedin.com/in/jane-doe/',
      message_text: '',
    };
    sessionStorage.setItem('pipeline_tracker_rescued_events', JSON.stringify([event]));
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    await replayRescueBuffer();

    const outbox = local[STORAGE_KEYS.OUTBOX] as OutboxEntry[];
    expect(outbox).toHaveLength(1);
    expect(outbox[0].event.name).toBe('Jane Doe');
    expect(sessionStorage.getItem('pipeline_tracker_rescued_events')).toBeNull();
  });

  // Rescue buffer: a no-op when there is nothing buffered.
  it('replayRescueBuffer is a no-op when the buffer is empty', async () => {
    await replayRescueBuffer();
    expect(local[STORAGE_KEYS.OUTBOX]).toBeUndefined();
  });

  it('debug_mode=false + scrape success → debug field absent', async () => {
    window.history.pushState({}, '', '/in/taniahansraj/');
    const main = document.createElement('main');
    const headingAnchor = document.createElement('a');
    headingAnchor.href = 'https://www.linkedin.com/in/taniahansraj/';
    const h2 = document.createElement('h2');
    h2.textContent = 'Tania Hansraj';
    headingAnchor.appendChild(h2);
    main.appendChild(headingAnchor);
    document.body.appendChild(main);

    const sendButton = document.createElement('button');
    sendButton.setAttribute('aria-label', 'Send without a note');
    document.body.appendChild(sendButton);

    await handleConnectionRequest(sendButton);

    const payload = lastEnqueuedEvent(local);
    expect(payload.debug).toBeUndefined();
  });
});

describe('pipeline-tracker content script — Sales Navigator connection request', () => {
  let local: Store;

  beforeEach(() => {
    vi.clearAllMocks();
    resetDedup();
    resetContextBanner();
    resetRescueBuffer();
    document.body.innerHTML = '';
    local = installStatefulLocalStorage();
    (chrome.storage.sync.get as ReturnType<typeof vi.fn>).mockResolvedValue({ debug_mode: false });
    window.history.pushState({}, '', '/sales/lead/ACwAACbVAzwB,NAME_SEARCH,qJrX');
  });

  afterEach(() => {
    window.history.pushState({}, '', '/');
  });

  /** Build the "Send invitation" modal (name + optional note). */
  function makeConnectModal(name: string, note?: string): HTMLElement {
    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    const heading = document.createElement('h2');
    heading.id = 'connect-cta-form__header';
    heading.textContent = 'Send invitation';
    modal.appendChild(heading);
    const nameEl = document.createElement('div');
    nameEl.setAttribute('data-anonymize', 'person-name');
    nameEl.textContent = name;
    modal.appendChild(nameEl);
    const textarea = document.createElement('textarea');
    textarea.id = 'connect-cta-form__invitation';
    if (note !== undefined) textarea.value = note;
    modal.appendChild(textarea);
    const sendButton = document.createElement('button');
    sendButton.className = 'connect-cta-form__send';
    sendButton.textContent = 'Send Invitation';
    modal.appendChild(sendButton);
    return modal;
  }

  it('merges staged title/url with the modal name + note', async () => {
    const modal = makeConnectModal('David Janotka', 'Hi David, would love to connect!');
    document.body.appendChild(modal);
    const sendButton = modal.querySelector('button')!;

    await handleSalesNavConnectionRequest(
      sendButton,
      'David Janotka',
      'Founder & Managing Director at Web3 Recruit',
      'https://www.linkedin.com/in/david-janotka-138226162',
    );

    const payload = lastEnqueuedEvent(local);
    expect(payload.event_type).toBe('connection_request');
    expect(payload.name).toBe('David Janotka');
    expect(payload.title).toBe('Founder & Managing Director at Web3 Recruit');
    expect(payload.linkedin_url).toBe('https://www.linkedin.com/in/david-janotka-138226162');
    expect(payload.message_text).toBe('Hi David, would love to connect!');
  });

  it('falls back to the lead header when no data was staged', async () => {
    // Lead header in the document
    const header = document.createElement('section');
    const h1 = document.createElement('h1');
    h1.setAttribute('data-x--lead--name', '');
    h1.setAttribute('data-anonymize', 'person-name');
    const nameLink = document.createElement('a');
    nameLink.setAttribute('data-anonymize', 'person-name');
    nameLink.setAttribute('href', '/sales/lead/ACwAACbVAzwB,NAME_SEARCH,qJrX');
    nameLink.textContent = 'David Janotka';
    h1.appendChild(nameLink);
    header.appendChild(h1);
    const headline = document.createElement('span');
    headline.setAttribute('data-anonymize', 'headline');
    headline.textContent = 'Founder & Managing Director at Web3 Recruit';
    header.appendChild(headline);
    document.body.appendChild(header);

    const modal = makeConnectModal('David Janotka');
    document.body.appendChild(modal);
    const sendButton = modal.querySelector('button')!;

    // No pending args passed — must recover from the header
    await handleSalesNavConnectionRequest(sendButton);

    const payload = lastEnqueuedEvent(local);
    expect(payload.name).toBe('David Janotka');
    expect(payload.title).toBe('Founder & Managing Director at Web3 Recruit');
    expect(payload.linkedin_url).toBe('https://www.linkedin.com/sales/lead/ACwAACbVAzwB');
  });

  it('end-to-end click path: Connect in a preview menu stages the URL, modal Send uses it', async () => {
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    // Preview menu with a public /in/ link, rendered detached at the doc root
    const menu = document.createElement('ul');
    const connectLi = document.createElement('li');
    const connectBtn = document.createElement('button');
    connectBtn.textContent = 'Connect';
    connectLi.appendChild(connectBtn);
    menu.appendChild(connectLi);
    const viewLi = document.createElement('li');
    const viewLink = document.createElement('a');
    viewLink.setAttribute('href', 'https://www.linkedin.com/in/david-janotka-138226162');
    viewLink.textContent = 'View LinkedIn profile';
    viewLi.appendChild(viewLink);
    menu.appendChild(viewLi);
    document.body.appendChild(menu);

    // Click "Connect" → the document listener stages the menu's profile URL.
    connectBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    // The "Send invitation" modal opens; clicking Send fires the captured event.
    const modal = makeConnectModal('David Janotka', 'Hi David!');
    document.body.appendChild(modal);
    const sendButton = modal.querySelector('button')!;
    sendButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await vi.waitFor(() => {
      const outbox = local[STORAGE_KEYS.OUTBOX] as OutboxEntry[] | undefined;
      if (!outbox || outbox.length === 0) throw new Error('not enqueued yet');
    });

    const payload = lastEnqueuedEvent(local);
    expect(payload.event_type).toBe('connection_request');
    expect(payload.name).toBe('David Janotka');
    expect(payload.linkedin_url).toBe('https://www.linkedin.com/in/david-janotka-138226162');
    expect(payload.message_text).toBe('Hi David!');
  });
});
