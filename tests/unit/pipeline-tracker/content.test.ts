// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleConnectionRequest, resetDedup } from '../../../pipeline-tracker/src/content.ts';
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
    expect(payload.debug!.container_html.length).toBeLessThanOrEqual(10000);
    expect(payload.debug!.page_url).toContain('/in/taniahansraj/');
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
