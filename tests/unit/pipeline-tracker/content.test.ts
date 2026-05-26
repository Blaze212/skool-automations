// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleConnectionRequest, resetDedup } from '../../../pipeline-tracker/src/content.ts';
import type { PipelineEvent } from '../../../pipeline-tracker/src/types.ts';

describe('pipeline-tracker content script — handleConnectionRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDedup();
    document.body.innerHTML = '';
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

    const payload = (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as PipelineEvent;
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

    const payload = (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as PipelineEvent;
    expect(payload.name).toBe('Pending Name');
    expect(payload.title).toBe('Pending Title');
    expect(payload.linkedin_url).toBe('https://www.linkedin.com/in/pending-vanity');
  });
});
