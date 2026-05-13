// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionSearchCard } from '../../../linkedin-tracker/src/connection-search-card.ts';
import { ProfilePageCard } from '../../../linkedin-tracker/src/profile-page-card.ts';
import {
  handleConnectionRequest,
  handleDirectMessage,
  resetDedup,
} from '../../../linkedin-tracker/src/content.ts';
import type { TrackerEvent } from '../../../linkedin-tracker/src/types.ts';

/**
 * Builds a minimal LinkedIn search-result card matching the [role="listitem"] structure.
 * Returns both the card root and the connect anchor so tests can call extractCardTitle directly.
 */
function makeSearchCard(
  name: string,
  vanityName: string,
  title: string,
  opts: { omitNamePara?: boolean; addCurrentSnippet?: boolean } = {},
): { card: HTMLElement; connectLink: HTMLElement } {
  const card = document.createElement('div');
  card.setAttribute('role', 'listitem');

  // Card wrapper <a> — the outer clickable link for the whole card
  const cardAnchor = document.createElement('a');
  cardAnchor.href = `https://www.linkedin.com/in/${vanityName}/`;
  cardAnchor.setAttribute('tabindex', '0');

  // Info block containing name <p>, title sibling, location sibling
  const infoBlock = document.createElement('div');

  if (!opts.omitNamePara) {
    const namePara = document.createElement('p');
    const nameLink = document.createElement('a');
    nameLink.href = `https://www.linkedin.com/in/${vanityName}/`;
    nameLink.textContent = name;
    namePara.appendChild(nameLink);
    infoBlock.appendChild(namePara);

    const titleDiv = document.createElement('div');
    const titlePara = document.createElement('p');
    const titleSpan = document.createElement('span');
    titleSpan.textContent = title;
    titlePara.appendChild(titleSpan);
    titleDiv.appendChild(titlePara);
    infoBlock.appendChild(titleDiv);

    const locationDiv = document.createElement('div');
    const locationPara = document.createElement('p');
    const locationSpan = document.createElement('span');
    locationSpan.textContent = 'Austin, Texas, United States';
    locationPara.appendChild(locationSpan);
    locationDiv.appendChild(locationPara);
    infoBlock.appendChild(locationDiv);
  }

  // Connect button (inside the card anchor)
  const connectLink = document.createElement('a');
  connectLink.href = `/preload/search-custom-invite/?vanityName=${vanityName}`;
  connectLink.setAttribute('aria-label', `Invite ${name} to connect`);

  cardAnchor.appendChild(infoBlock);
  cardAnchor.appendChild(connectLink);
  card.appendChild(cardAnchor);

  // "Current: ..." snippet LinkedIn appends below some cards
  if (opts.addCurrentSnippet) {
    const snippetDiv = document.createElement('div');
    const snippetPara = document.createElement('p');
    const snippetSpan = document.createElement('span');
    snippetSpan.textContent = `Current: ${title}`;
    snippetPara.appendChild(snippetSpan);
    snippetDiv.appendChild(snippetPara);
    card.appendChild(snippetDiv);
  }

  return { card, connectLink };
}

function makeInviteButton(name: string): HTMLButtonElement {
  const modal = document.createElement('div');
  modal.setAttribute('role', 'dialog');

  const heading = document.createElement('h2');
  heading.textContent = name;
  modal.appendChild(heading);

  const subtitle = document.createElement('div');
  subtitle.className = 'artdeco-entity-lockup__subtitle';
  subtitle.textContent = 'Software Engineer at Acme';
  modal.appendChild(subtitle);

  const button = document.createElement('button');
  button.setAttribute('aria-label', 'Send invite');
  button.textContent = 'Send invite';
  modal.appendChild(button);

  document.body.appendChild(modal);
  return button;
}

function makeInviteLink(name: string): HTMLAnchorElement {
  const link = document.createElement('a');
  link.setAttribute('aria-label', `Invite ${name} to connect`);
  link.href = `/preload/search-custom-invite/?vanityName=test`;
  document.body.appendChild(link);
  return link;
}

/**
 * Builds a minimal LinkedIn profile-page sidebar card (e.g. "People you may know").
 * The connect link lives in a separate branch from the heading link, mirroring the
 * real DOM structure where the name heading and action buttons are in different subtrees.
 */
function makeProfileCard(
  name: string,
  vanityName: string,
  title: string,
): { card: HTMLElement; connectLink: HTMLElement } {
  const card = document.createElement('div');

  // Left section: name row then title/company siblings
  const leftSection = document.createElement('div');

  const nameRow = document.createElement('div');

  const nameWrapper = document.createElement('div');
  nameWrapper.setAttribute('data-display-contents', 'true');

  const profileLink = document.createElement('a');
  profileLink.href = `https://www.linkedin.com/in/${vanityName}/`;
  const headingDiv = document.createElement('div');
  const heading = document.createElement('h2');
  heading.textContent = name;
  headingDiv.appendChild(heading);
  profileLink.appendChild(headingDiv);
  nameWrapper.appendChild(profileLink);
  nameRow.appendChild(nameWrapper);

  // Degree badges as siblings of nameWrapper — these must be skipped by title extraction
  const degreeDiv = document.createElement('div');
  degreeDiv.setAttribute('data-display-contents', 'true');
  const degreePara = document.createElement('p');
  degreePara.textContent = '· 1st';
  degreeDiv.appendChild(degreePara);
  nameRow.appendChild(degreeDiv);

  const degree2Para = document.createElement('p');
  degree2Para.textContent = '· 2nd';
  nameRow.appendChild(degree2Para);

  leftSection.appendChild(nameRow);

  // Title paragraph — first meaningful <p> sibling of nameRow
  const titlePara = document.createElement('p');
  titlePara.textContent = title;
  leftSection.appendChild(titlePara);

  // Company/school paragraph (should not be returned as title)
  const companyPara = document.createElement('p');
  companyPara.textContent = 'Oracle · Some University';
  leftSection.appendChild(companyPara);

  card.appendChild(leftSection);

  // Actions section in a separate branch from the heading
  const actionsDiv = document.createElement('div');
  actionsDiv.setAttribute('data-display-contents', 'true');

  const connectLink = document.createElement('a');
  connectLink.href = `/preload/custom-invite/?vanityName=${vanityName}`;
  connectLink.setAttribute('aria-label', `Invite ${name} to connect`);
  connectLink.textContent = 'Connect';
  actionsDiv.appendChild(connectLink);

  card.appendChild(actionsDiv);

  return { card, connectLink };
}

function makeDmButton(name: string, title: string, messageText: string): HTMLButtonElement {
  const nameEl = document.createElement('div');
  nameEl.className = 'msg-entity-lockup__entity-title';
  nameEl.textContent = name;
  document.body.appendChild(nameEl);

  const titleEl = document.createElement('div');
  titleEl.className = 'artdeco-entity-lockup__subtitle';
  titleEl.textContent = title;
  document.body.appendChild(titleEl);

  const form = document.createElement('div');
  form.className = 'msg-form';

  const composer = document.createElement('div');
  composer.className = 'msg-form__contenteditable';
  composer.setAttribute('contenteditable', 'true');
  composer.textContent = messageText;
  form.appendChild(composer);

  const button = document.createElement('button');
  button.setAttribute('aria-label', 'Send message');
  button.textContent = 'Send';
  form.appendChild(button);

  document.body.appendChild(form);
  return button;
}

describe('content script', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDedup();
    document.body.innerHTML = '';
    (chrome.storage.sync.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      debug_mode: false,
    });
  });

  describe('handleConnectionRequest', () => {
    it('sends correct payload shape for connection request', async () => {
      const button = makeInviteButton('Jane Doe');
      await handleConnectionRequest(button);

      expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
      const payload = (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as TrackerEvent;
      expect(payload.message_type).toBe('Connection Request');
      expect(payload.name).toBe('Jane Doe');
      expect(payload.title).toBe('Software Engineer at Acme');
      expect(payload.status).toBe('Sent');
      expect(payload.company).toBe('');
      expect(typeof payload.page_url).toBe('string');
    });

    it('warns and sends partial payload when name element missing', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const button = document.createElement('button');
      button.setAttribute('aria-label', 'Send invite');
      document.body.appendChild(button);

      await handleConnectionRequest(button);

      expect(warnSpy).toHaveBeenCalled();
      expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });

    it('dedup guard drops second event within 500ms', async () => {
      const button = makeInviteButton('Jane Doe');
      await handleConnectionRequest(button);
      await handleConnectionRequest(button);

      expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('dedup guard passes second event after 500ms', async () => {
      vi.useFakeTimers();
      const button = makeInviteButton('Jane Doe');
      await handleConnectionRequest(button);
      vi.advanceTimersByTime(501);
      await handleConnectionRequest(button);
      vi.useRealTimers();

      expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(2);
    });

    it('debug_mode=true + scrape success → debug field absent', async () => {
      (chrome.storage.sync.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        debug_mode: true,
      });
      const button = makeInviteButton('Jane Doe');
      await handleConnectionRequest(button);

      const payload = (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as TrackerEvent;
      expect(payload.debug).toBeUndefined();
    });

    it('extracts name from "Invite [Name] to connect" aria-label when passed as pendingName', async () => {
      // The <a> click stores the name; the modal send button calls handleConnectionRequest with it
      const button = document.createElement('button');
      button.setAttribute('aria-label', 'Send without a note');
      document.body.appendChild(button);

      await handleConnectionRequest(button, 'Jane Doe');

      const payload = (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as TrackerEvent;
      expect(payload.message_type).toBe('Connection Request');
      expect(payload.name).toBe('Jane Doe');
    });

    it('pendingName takes priority when modal heading is absent', async () => {
      const button = document.createElement('button');
      button.setAttribute('aria-label', 'Send invite');
      document.body.appendChild(button);

      await handleConnectionRequest(button, 'Pre-stored Name');

      const payload = (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as TrackerEvent;
      expect(payload.name).toBe('Pre-stored Name');
    });

    it('pendingTitle takes priority over modal subtitle', async () => {
      const button = makeInviteButton('Jane Doe'); // modal has "Software Engineer at Acme"
      await handleConnectionRequest(button, 'Jane Doe', 'VP of Product at BigCo');

      const payload = (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as TrackerEvent;
      expect(payload.title).toBe('VP of Product at BigCo');
    });

    it('falls back to modal subtitle when pendingTitle absent', async () => {
      const button = makeInviteButton('Jane Doe');
      await handleConnectionRequest(button, 'Jane Doe');

      const payload = (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as TrackerEvent;
      expect(payload.title).toBe('Software Engineer at Acme');
    });

    it('debug_mode=true + scrape failure → debug field present with container_html ≤ 10000 chars', async () => {
      (chrome.storage.sync.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        debug_mode: true,
      });
      // No modal, so name scrape will fail
      const button = document.createElement('button');
      button.setAttribute('aria-label', 'Send invite');
      document.body.appendChild(button);

      await handleConnectionRequest(button);

      const payload = (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as TrackerEvent;
      expect(payload.debug).toBeDefined();
      expect(payload.debug!.container_html.length).toBeLessThanOrEqual(10000);
    });
  });

  describe('handleDirectMessage', () => {
    it('sends correct payload shape for direct message via button click', async () => {
      const button = makeDmButton('John Smith', 'CTO at StartupCo', 'Hello there!');
      await handleDirectMessage(button);

      expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
      const payload = (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as TrackerEvent;
      expect(payload.message_type).toBe('Direct Message');
      expect(payload.name).toBe('John Smith');
      expect(payload.title).toBe('CTO at StartupCo');
      expect(payload.message_text).toBe('Hello there!');
      expect(payload.status).toBe('Sent');
      expect(typeof payload.page_url).toBe('string');
    });

    it('sends correct payload for Enter key (null button)', async () => {
      makeDmButton('John Smith', 'CTO at StartupCo', 'Hello there!');
      await handleDirectMessage(null);

      const payload = (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as TrackerEvent;
      expect(payload.message_type).toBe('Direct Message');
      expect(payload.name).toBe('John Smith');
    });

    it('dedup guard prevents double-fire from button + Enter within 500ms', async () => {
      const button = makeDmButton('John Smith', 'CTO at StartupCo', 'Hello!');
      await handleDirectMessage(button);
      await handleDirectMessage(null);

      expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('warns when conversation header is missing', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // No name element in DOM
      const button = document.createElement('button');
      button.setAttribute('aria-label', 'Send message');
      document.body.appendChild(button);

      await handleDirectMessage(button);

      expect(warnSpy).toHaveBeenCalled();
      expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });

    it('extracts name, url, and title via profile picture lockup (full messaging page)', async () => {
      // Simulate the full /messaging/ page: an entity lockup with profile picture,
      // name link, and subtitle div[title] — the structural approach without class names.
      const conversationContainer = document.createElement('div');

      const lockup = document.createElement('div');

      // Profile picture: <a href="/in/..."><img><span class="a11y-text">...status is offline</span></a>
      // This link must be skipped — textContent includes the a11y status string.
      const photoLink = document.createElement('a');
      photoLink.href = 'https://www.linkedin.com/in/pratik-patil/';
      const img = document.createElement('img');
      img.src = 'https://media.licdn.com/photo.jpg';
      const a11ySpan = document.createElement('span');
      a11ySpan.textContent = 'Pratik Patil status is offline';
      photoLink.appendChild(img);
      photoLink.appendChild(a11ySpan);
      lockup.appendChild(photoLink);

      const content = document.createElement('div');
      const titleRow = document.createElement('div');
      const nameLink = document.createElement('a');
      nameLink.href = 'https://www.linkedin.com/in/pratik-patil/';
      const nameSpan = document.createElement('span');
      nameSpan.textContent = 'Pratik Patil';
      nameLink.appendChild(nameSpan);
      titleRow.appendChild(nameLink);
      content.appendChild(titleRow);

      const subtitleRow = document.createElement('div');
      const subtitleInner = document.createElement('div');
      subtitleInner.setAttribute('title', 'Senior Software Engineer at Oracle');
      subtitleInner.textContent = 'Senior Software Engineer at Oracle';
      subtitleRow.appendChild(subtitleInner);
      content.appendChild(subtitleRow);

      lockup.appendChild(content);
      conversationContainer.appendChild(lockup);

      const form = document.createElement('form');
      const composer = document.createElement('div');
      composer.setAttribute('contenteditable', 'true');
      composer.textContent = 'Hello Pratik!';
      form.appendChild(composer);
      const button = document.createElement('button');
      button.textContent = 'Send';
      form.appendChild(button);
      conversationContainer.appendChild(form);

      document.body.appendChild(conversationContainer);

      await handleDirectMessage(button);

      const payload = (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as TrackerEvent;
      expect(payload.name).toBe('Pratik Patil');
      expect(payload.profile_url).toBe('https://www.linkedin.com/in/pratik-patil/');
      expect(payload.title).toBe('Senior Software Engineer at Oracle');
      expect(payload.message_text).toBe('Hello Pratik!');
    });

    it('extracts name from overlay bubble header via structural <header> + <form>', async () => {
      // Simulate the overlay popup: a conversation container holds a <header> with the
      // profile link at the top and a <form> with the contenteditable + Send button below.
      const conversationContainer = document.createElement('div');

      const header = document.createElement('header');
      const nameLink = document.createElement('a');
      nameLink.href = '/in/dave-tanacea/';
      const nameSpan = document.createElement('span');
      nameSpan.textContent = 'Dave Tanacea';
      nameLink.appendChild(nameSpan);
      header.appendChild(nameLink);
      conversationContainer.appendChild(header);

      const form = document.createElement('form');
      const composer = document.createElement('div');
      composer.setAttribute('contenteditable', 'true');
      composer.textContent = 'Hello Dave!';
      form.appendChild(composer);
      const button = document.createElement('button');
      button.textContent = 'Send';
      form.appendChild(button);
      conversationContainer.appendChild(form);

      document.body.appendChild(conversationContainer);

      await handleDirectMessage(button);

      const payload = (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as TrackerEvent;
      expect(payload.name).toBe('Dave Tanacea');
      expect(payload.message_text).toBe('Hello Dave!');
    });
  });

  describe('ConnectionSearchCard', () => {
    describe('.title', () => {
      it('extracts title via structural sibling navigation in [role="listitem"] card', () => {
        const { card, connectLink } = makeSearchCard(
          'Chandana Yenugu',
          'chandanayn',
          'Senior Software Development Engineer at Oracle',
        );
        expect(new ConnectionSearchCard(card, connectLink).title).toBe(
          'Senior Software Development Engineer at Oracle',
        );
      });

      it('ignores location sibling and returns only the title text', () => {
        const { card, connectLink } = makeSearchCard(
          'Pooja Ravi',
          'pooja-ravi',
          'Senior Software Engineer @ Oracle | MS in CS',
        );
        expect(new ConnectionSearchCard(card, connectLink).title).toBe(
          'Senior Software Engineer @ Oracle | MS in CS',
        );
      });

      it('falls back to "Current:" snippet when name paragraph is absent', () => {
        const { card, connectLink } = makeSearchCard(
          'Yi Fan',
          'yi-fan-rkkf7',
          'Senior Software Engineer at Oracle',
          { omitNamePara: true, addCurrentSnippet: true },
        );
        expect(new ConnectionSearchCard(card, connectLink).title).toBe(
          'Senior Software Engineer at Oracle',
        );
      });

      it('returns empty string when vanityName is absent from connect href', () => {
        const { card } = makeSearchCard('Test User', 'testuser', 'Some Title');
        const badLink = document.createElement('a');
        badLink.href = '/connect';
        expect(new ConnectionSearchCard(card, badLink).title).toBe('');
      });

      it('prefers structural nav over "Current:" when both are present', () => {
        const { card, connectLink } = makeSearchCard(
          'Zhaosong Zhu',
          'zzhu12',
          'Senior Software Engineer @ Oracle Cloud Infrastructure',
          { addCurrentSnippet: true },
        );
        expect(new ConnectionSearchCard(card, connectLink).title).toBe(
          'Senior Software Engineer @ Oracle Cloud Infrastructure',
        );
      });
    });

    describe('.profileUrl', () => {
      it('returns canonical LinkedIn URL from vanityName in connect href', () => {
        const { card, connectLink } = makeSearchCard('Test', 'chandanayn', 'Title');
        expect(new ConnectionSearchCard(card, connectLink).profileUrl).toBe(
          'https://www.linkedin.com/in/chandanayn/',
        );
      });

      it('falls back to card wrapper <a> href when no vanityName param', () => {
        const link = document.createElement('a');
        link.href = '/connect/other';
        const card = document.createElement('div');
        card.setAttribute('role', 'listitem');
        const cardAnchor = document.createElement('a');
        cardAnchor.href = 'https://www.linkedin.com/in/testuser/';
        card.appendChild(cardAnchor);
        expect(new ConnectionSearchCard(card, link).profileUrl).toBe(
          'https://www.linkedin.com/in/testuser/',
        );
      });

      it('strips query string from card wrapper href fallback', () => {
        const link = document.createElement('a');
        link.href = '/connect/other';
        const card = document.createElement('div');
        const cardAnchor = document.createElement('a');
        cardAnchor.href = 'https://www.linkedin.com/in/testuser/?trk=something';
        card.appendChild(cardAnchor);
        expect(new ConnectionSearchCard(card, link).profileUrl).toBe(
          'https://www.linkedin.com/in/testuser/',
        );
      });

      it('returns empty string when no vanityName and no card-wrapper link', () => {
        const link = document.createElement('a');
        link.href = '/connect/other';
        const card = document.createElement('div');
        expect(new ConnectionSearchCard(card, link).profileUrl).toBe('');
      });
    });

    describe('.fromConnectLink', () => {
      it('returns null when connect link has no [role="listitem"] ancestor', () => {
        const link = document.createElement('a');
        link.href = '/preload/search-custom-invite/?vanityName=test';
        document.body.appendChild(link);
        expect(ConnectionSearchCard.fromConnectLink(link)).toBeNull();
      });

      it('builds a card when connect link is inside [role="listitem"]', () => {
        const { card, connectLink } = makeSearchCard(
          'Kyle Burda',
          'kyleburda',
          'Senior Software Engineer at Oracle',
        );
        document.body.appendChild(card);
        const result = ConnectionSearchCard.fromConnectLink(connectLink);
        expect(result).not.toBeNull();
        expect(result!.title).toBe('Senior Software Engineer at Oracle');
        expect(result!.profileUrl).toBe('https://www.linkedin.com/in/kyleburda/');
      });
    });

    it('PAGE_PATH_PATTERN matches /search/results/people/ URLs', () => {
      expect(ConnectionSearchCard.PAGE_PATH_PATTERN.test('/search/results/people/')).toBe(true);
      expect(
        ConnectionSearchCard.PAGE_PATH_PATTERN.test('/search/results/people/?keywords=oracle'),
      ).toBe(true);
      expect(ConnectionSearchCard.PAGE_PATH_PATTERN.test('/in/someuser')).toBe(false);
    });
  });

  describe('ProfilePageCard', () => {
    describe('.fromConnectLink', () => {
      it('returns a ProfilePageCard for a profile-page connect href', () => {
        const { card, connectLink } = makeProfileCard('Chandana Yenugu', 'chandanayn', 'Title');
        document.body.appendChild(card);
        expect(ProfilePageCard.fromConnectLink(connectLink)).not.toBeNull();
      });

      it('returns null for a search-page connect href (search-custom-invite)', () => {
        const link = document.createElement('a');
        link.href = '/preload/search-custom-invite/?vanityName=testuser';
        expect(ProfilePageCard.fromConnectLink(link)).toBeNull();
      });

      it('returns null when href has no vanityName param', () => {
        const link = document.createElement('a');
        link.href = '/preload/custom-invite/';
        expect(ProfilePageCard.fromConnectLink(link)).toBeNull();
      });

      it('returns null for an unrelated href', () => {
        const link = document.createElement('a');
        link.href = '/messaging/compose/';
        expect(ProfilePageCard.fromConnectLink(link)).toBeNull();
      });

      it('returns null when no heading link found in any ancestor', () => {
        const div = document.createElement('div');
        const link = document.createElement('a');
        link.href = '/preload/custom-invite/?vanityName=ghost-user';
        div.appendChild(link);
        document.body.appendChild(div);
        expect(ProfilePageCard.fromConnectLink(link)).toBeNull();
      });

      it('builds a card and resolves title when connect link is inside a proper card', () => {
        const { card, connectLink } = makeProfileCard(
          'Kyle Burda',
          'kyleburda',
          'Senior Software Engineer at Oracle',
        );
        document.body.appendChild(card);
        const result = ProfilePageCard.fromConnectLink(connectLink);
        expect(result).not.toBeNull();
        expect(result!.title).toBe('Senior Software Engineer at Oracle');
        expect(result!.profileUrl).toBe('https://www.linkedin.com/in/kyleburda/');
      });
    });

    describe('.profileUrl', () => {
      it('returns canonical LinkedIn URL from vanityName', () => {
        const { card, connectLink } = makeProfileCard('Test', 'chandanayn', 'Title');
        expect(new ProfilePageCard(connectLink, card).profileUrl).toBe(
          'https://www.linkedin.com/in/chandanayn/',
        );
      });

      it('returns empty string when connect href has no vanityName', () => {
        const card = document.createElement('div');
        const link = document.createElement('a');
        link.href = '/preload/custom-invite/';
        card.appendChild(link);
        expect(new ProfilePageCard(link, card).profileUrl).toBe('');
      });
    });

    describe('.title', () => {
      it('extracts headline from the first meaningful <p> sibling after the name row', () => {
        const { card, connectLink } = makeProfileCard(
          'Chandana Yenugu',
          'chandanayn',
          'Senior Software Development Engineer at Oracle',
        );
        expect(new ProfilePageCard(connectLink, card).title).toBe(
          'Senior Software Development Engineer at Oracle',
        );
      });

      it('skips degree markers (· 1st, · 2nd) and returns the real headline', () => {
        const { card, connectLink } = makeProfileCard(
          'Pooja Ravi',
          'pooja-ravi-385576121',
          'Senior Software Engineer @ Oracle | MS in Computer Science',
        );
        expect(new ProfilePageCard(connectLink, card).title).toBe(
          'Senior Software Engineer @ Oracle | MS in Computer Science',
        );
      });

      it('skips numeric sibling text (e.g. connections count) and returns headline', () => {
        const { card, connectLink } = makeProfileCard(
          'Ryan Denney',
          'ryan-denney-1418001b9',
          'Senior Software Engineer with OCI',
        );
        // Insert a numeric <p> before the title to verify it is skipped
        const leftSection = card.firstElementChild as HTMLElement;
        const countPara = document.createElement('p');
        countPara.textContent = '289 followers';
        leftSection.insertBefore(countPara, leftSection.children[1]); // before titlePara
        expect(new ProfilePageCard(connectLink, card).title).toBe(
          'Senior Software Engineer with OCI',
        );
      });

      it('returns empty string when connect href has no vanityName', () => {
        const card = document.createElement('div');
        const link = document.createElement('a');
        link.href = '/preload/custom-invite/';
        card.appendChild(link);
        expect(new ProfilePageCard(link, card).title).toBe('');
      });

      it('returns empty string when card contains no matching heading link', () => {
        const card = document.createElement('div');
        const link = document.createElement('a');
        link.href = '/preload/custom-invite/?vanityName=nobody';
        card.appendChild(link);
        expect(new ProfilePageCard(link, card).title).toBe('');
      });
    });

    it('PAGE_PATH_PATTERN matches /in/vanityName/ URLs', () => {
      expect(ProfilePageCard.PAGE_PATH_PATTERN.test('/in/chandanayn/')).toBe(true);
      expect(ProfilePageCard.PAGE_PATH_PATTERN.test('/in/pooja-ravi-385576121/')).toBe(true);
      expect(ProfilePageCard.PAGE_PATH_PATTERN.test('/search/results/people/')).toBe(false);
      expect(ProfilePageCard.PAGE_PATH_PATTERN.test('/feed')).toBe(false);
    });
  });
});
