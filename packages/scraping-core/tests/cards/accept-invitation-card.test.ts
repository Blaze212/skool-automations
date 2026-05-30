// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import { AcceptInvitationCard } from '../../src/cards/accept-invitation-card.ts';

function makeInvitationCard(
  name: string,
  vanityName: string,
  title: string,
  opts: { ariaLabel?: string; omitNamePara?: boolean; messageText?: string } = {},
): { card: HTMLElement; acceptButton: HTMLElement } {
  const card = document.createElement('li');
  card.setAttribute('role', 'listitem');

  const avatarLink = document.createElement('a');
  avatarLink.href = `https://www.linkedin.com/in/${vanityName}/`;
  const avatar = document.createElement('img');
  avatarLink.appendChild(avatar);
  card.appendChild(avatarLink);

  if (!opts.omitNamePara) {
    const namePara = document.createElement('p');
    const nameLink = document.createElement('a');
    nameLink.href = `https://www.linkedin.com/in/${vanityName}/`;
    nameLink.textContent = name;
    namePara.appendChild(nameLink);
    card.appendChild(namePara);

    const titleDiv = document.createElement('div');
    const titleSpan = document.createElement('span');
    titleSpan.textContent = title;
    titleDiv.appendChild(titleSpan);
    card.appendChild(titleDiv);
  }

  if (opts.messageText) {
    const noteBox = document.createElement('div');
    noteBox.setAttribute('data-testid', 'expandable-text-box');
    noteBox.textContent = opts.messageText;
    card.appendChild(noteBox);
  }

  const acceptButton = document.createElement('button');
  acceptButton.setAttribute('aria-label', opts.ariaLabel ?? `Accept ${name}'s invitation`);
  acceptButton.textContent = 'Accept';
  card.appendChild(acceptButton);

  const ignoreButton = document.createElement('button');
  ignoreButton.setAttribute('aria-label', `Ignore ${name}'s invitation`);
  ignoreButton.textContent = 'Ignore';
  card.appendChild(ignoreButton);

  return { card, acceptButton };
}

describe('AcceptInvitationCard', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('.fromAcceptButton', () => {
    it('returns an AcceptInvitationCard when button is inside [role=listitem]', () => {
      const { card, acceptButton } = makeInvitationCard('Omkar Dedge', 'omkar-dedge', 'Engineer');
      document.body.appendChild(card);
      expect(AcceptInvitationCard.fromAcceptButton(acceptButton)).not.toBeNull();
    });

    it('returns null when button has no [role=listitem] or li ancestor', () => {
      const button = document.createElement('button');
      button.setAttribute('aria-label', "Accept Jane's invitation");
      document.body.appendChild(button);
      expect(AcceptInvitationCard.fromAcceptButton(button)).toBeNull();
    });

    it('finds card from a button nested inside multiple wrappers', () => {
      const { card, acceptButton } = makeInvitationCard('Alice', 'alice', 'Designer');
      const wrapper = document.createElement('div');
      wrapper.appendChild(acceptButton);
      card.appendChild(wrapper);
      document.body.appendChild(card);
      expect(AcceptInvitationCard.fromAcceptButton(acceptButton)).not.toBeNull();
    });
  });

  describe('.name', () => {
    it('extracts name from curly-apostrophe aria-label (U+2019)', () => {
      const { card, acceptButton } = makeInvitationCard('Omkar Dedge', 'omkar-dedge', 'Engineer', {
        ariaLabel: 'Accept Omkar Dedge’s invitation',
      });
      expect(new AcceptInvitationCard(card, acceptButton).name).toBe('Omkar Dedge');
    });

    it('extracts name from straight-apostrophe aria-label (U+0027)', () => {
      const { card, acceptButton } = makeInvitationCard('Jane Smith', 'jane-smith', 'Designer', {
        ariaLabel: "Accept Jane Smith's invitation",
      });
      expect(new AcceptInvitationCard(card, acceptButton).name).toBe('Jane Smith');
    });

    it('extracts name from request-variant label with curly apostrophe', () => {
      const { card, acceptButton } = makeInvitationCard('Bob Jones', 'bob-jones', 'PM', {
        ariaLabel: 'Accept Bob Jones’s request to connect',
      });
      expect(new AcceptInvitationCard(card, acceptButton).name).toBe('Bob Jones');
    });

    it('falls back to /in/ link text when aria-label has no name pattern', () => {
      const { card, acceptButton } = makeInvitationCard('Alice Lee', 'alice-lee', 'Director', {
        ariaLabel: 'Accept',
      });
      expect(new AcceptInvitationCard(card, acceptButton).name).toBe('Alice Lee');
    });

    it('returns empty string when no name source is available', () => {
      const card = document.createElement('li');
      card.setAttribute('role', 'listitem');
      const button = document.createElement('button');
      button.setAttribute('aria-label', 'Accept');
      card.appendChild(button);
      expect(new AcceptInvitationCard(card, button).name).toBe('');
    });
  });

  describe('.title', () => {
    it('extracts title via name-p sibling walk (S1)', () => {
      const { card, acceptButton } = makeInvitationCard(
        'Omkar Dedge',
        'omkar-dedge',
        'Senior Software Engineer at Acme',
      );
      expect(new AcceptInvitationCard(card, acceptButton).title).toBe(
        'Senior Software Engineer at Acme',
      );
    });

    it('falls back to longest non-anchor span when name-para absent (S2)', () => {
      const { card, acceptButton } = makeInvitationCard(
        'Bob Jones',
        'bob-jones',
        'Product Manager at BigCo',
        { omitNamePara: true },
      );
      const span = document.createElement('span');
      span.textContent = 'Product Manager at BigCo';
      card.appendChild(span);
      expect(new AcceptInvitationCard(card, acceptButton).title).toBe('Product Manager at BigCo');
    });

    it('skips noise text (mutual connections) and returns the real title', () => {
      const card = document.createElement('li');
      card.setAttribute('role', 'listitem');

      const namePara = document.createElement('p');
      const nameLink = document.createElement('a');
      nameLink.href = '/in/alice/';
      nameLink.textContent = 'Alice';
      namePara.appendChild(nameLink);
      card.appendChild(namePara);

      const noiseSib = document.createElement('div');
      noiseSib.textContent = '12 mutual connections';
      card.appendChild(noiseSib);

      const titleSib = document.createElement('div');
      titleSib.textContent = 'Staff Engineer at Stripe';
      card.appendChild(titleSib);

      const button = document.createElement('button');
      button.setAttribute('aria-label', "Accept Alice's invitation");
      card.appendChild(button);

      expect(new AcceptInvitationCard(card, button).title).toBe('Staff Engineer at Stripe');
    });

    it('returns empty string when no title can be found', () => {
      const { card, acceptButton } = makeInvitationCard('Bob', 'bob', 'x', {
        omitNamePara: true,
      });
      expect(new AcceptInvitationCard(card, acceptButton).title).toBe('');
    });
  });

  describe('.profileUrl', () => {
    it('returns normalized profile URL from non-avatar /in/ link', () => {
      const { card, acceptButton } = makeInvitationCard('Omkar Dedge', 'omkar-dedge', 'Engineer');
      expect(new AcceptInvitationCard(card, acceptButton).profileUrl).toBe(
        'https://www.linkedin.com/in/omkar-dedge',
      );
    });

    it('strips query params from profile URL', () => {
      const card = document.createElement('li');
      card.setAttribute('role', 'listitem');
      const nameLink = document.createElement('a');
      nameLink.href = 'https://www.linkedin.com/in/alice/?trk=something';
      nameLink.textContent = 'Alice';
      card.appendChild(nameLink);
      const button = document.createElement('button');
      button.setAttribute('aria-label', "Accept Alice's invitation");
      card.appendChild(button);
      expect(new AcceptInvitationCard(card, button).profileUrl).toBe(
        'https://www.linkedin.com/in/alice',
      );
    });

    it('returns empty string when no /in/ link present', () => {
      const card = document.createElement('li');
      const button = document.createElement('button');
      button.setAttribute('aria-label', "Accept Alice's invitation");
      card.appendChild(button);
      expect(new AcceptInvitationCard(card, button).profileUrl).toBe('');
    });
  });

  describe('.messageText', () => {
    it('returns invitation note when present', () => {
      const { card, acceptButton } = makeInvitationCard('Jane', 'jane', 'Engineer', {
        messageText: 'Hi, I came across your profile and would love to connect!',
      });
      expect(new AcceptInvitationCard(card, acceptButton).messageText).toBe(
        'Hi, I came across your profile and would love to connect!',
      );
    });

    it('returns empty string when no invitation note', () => {
      const { card, acceptButton } = makeInvitationCard('Jane', 'jane', 'Engineer');
      expect(new AcceptInvitationCard(card, acceptButton).messageText).toBe('');
    });
  });
});
