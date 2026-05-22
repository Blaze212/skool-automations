// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProfilePageAcceptCard } from '../../../pipeline-tracker/src/profile-page-accept-card.ts';

function setProfilePath(vanity: string): void {
  window.history.pushState({}, '', `/in/${vanity}/`);
}

/**
 * Builds a minimal version of the profile-page DOM shown when the viewer has a
 * pending incoming connection request from the profile owner.
 */
function makeProfilePage(opts: {
  vanity: string;
  name: string;
  pronouns?: string;
  headline?: string;
  location?: string;
  ariaLabel?: string;
}): { card: HTMLElement; acceptButton: HTMLElement } {
  // Outermost profile box
  const card = document.createElement('div');

  // Name + headline block
  const block = document.createElement('div');
  card.appendChild(block);

  // Name column (heading + pronouns + degree markers)
  const nameCol = document.createElement('div');
  block.appendChild(nameCol);

  const headingWrap = document.createElement('div');
  headingWrap.setAttribute('aria-expanded', 'false');
  nameCol.appendChild(headingWrap);

  const headingAnchor = document.createElement('a');
  headingAnchor.href = `https://www.linkedin.com/in/${opts.vanity}/`;
  const h2 = document.createElement('h2');
  h2.textContent = opts.name;
  headingAnchor.appendChild(h2);
  headingWrap.appendChild(headingAnchor);

  if (opts.pronouns) {
    const pronounP = document.createElement('p');
    pronounP.textContent = opts.pronouns;
    nameCol.appendChild(pronounP);
  }

  const degreeWrap = document.createElement('div');
  const degreeP = document.createElement('p');
  degreeP.textContent = '· 1st';
  degreeWrap.appendChild(degreeP);
  nameCol.appendChild(degreeWrap);

  // Headline (sibling of nameCol)
  if (opts.headline) {
    const headlineP = document.createElement('p');
    headlineP.textContent = opts.headline;
    block.appendChild(headlineP);
  }

  // Location + contact info group (also sibling)
  if (opts.location) {
    const locWrap = document.createElement('div');
    const locP = document.createElement('p');
    locP.textContent = opts.location;
    locWrap.appendChild(locP);
    const dotP = document.createElement('p');
    dotP.textContent = '·';
    locWrap.appendChild(dotP);
    const contactP = document.createElement('p');
    const contactA = document.createElement('a');
    contactA.href = '#';
    contactA.textContent = 'Contact info';
    contactP.appendChild(contactA);
    locWrap.appendChild(contactP);
    block.appendChild(locWrap);
  }

  // Mutual connection count + text (siblings on the card root)
  const countWrap = document.createElement('div');
  const countA = document.createElement('p');
  countA.textContent = '500+';
  const countB = document.createElement('p');
  countB.textContent = 'connections';
  countWrap.appendChild(countA);
  countWrap.appendChild(countB);
  card.appendChild(countWrap);

  // Actions row (Accept / Ignore / More)
  const actions = document.createElement('div');
  card.appendChild(actions);

  const acceptButton = document.createElement('button');
  acceptButton.setAttribute(
    'aria-label',
    opts.ariaLabel ?? `Accept ${opts.name}’s request to connect`,
  );
  const acceptSpan = document.createElement('span');
  acceptSpan.textContent = 'Accept';
  acceptButton.appendChild(acceptSpan);
  actions.appendChild(acceptButton);

  const ignoreButton = document.createElement('button');
  ignoreButton.setAttribute('aria-label', `Ignore ${opts.name}’s request to connect`);
  ignoreButton.textContent = 'Ignore';
  actions.appendChild(ignoreButton);

  return { card, acceptButton };
}

describe('ProfilePageAcceptCard', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    setProfilePath('default');
  });

  afterEach(() => {
    window.history.pushState({}, '', '/');
  });

  describe('.fromAcceptButton', () => {
    it('returns a ProfilePageAcceptCard when on /in/{vanity}/ and ancestor has the heading link', () => {
      setProfilePath('nishtalasn');
      const { card, acceptButton } = makeProfilePage({
        vanity: 'nishtalasn',
        name: 'Nirupama Nishtala',
        headline: 'Ph.D. | R&D Program Manager',
      });
      document.body.appendChild(card);
      expect(ProfilePageAcceptCard.fromAcceptButton(acceptButton)).not.toBeNull();
    });

    it('returns null when current page is not a profile page', () => {
      window.history.pushState({}, '', '/feed/');
      const { card, acceptButton } = makeProfilePage({
        vanity: 'nishtalasn',
        name: 'Nirupama Nishtala',
      });
      document.body.appendChild(card);
      expect(ProfilePageAcceptCard.fromAcceptButton(acceptButton)).toBeNull();
    });

    it('returns null when no ancestor of the button contains the heading link', () => {
      setProfilePath('nishtalasn');
      const button = document.createElement('button');
      button.setAttribute('aria-label', "Accept Someone's request to connect");
      document.body.appendChild(button);
      expect(ProfilePageAcceptCard.fromAcceptButton(button)).toBeNull();
    });
  });

  describe('.name', () => {
    it('extracts name from the <h2> inside the profile heading anchor', () => {
      setProfilePath('nishtalasn');
      const { card, acceptButton } = makeProfilePage({
        vanity: 'nishtalasn',
        name: 'Nirupama Nishtala',
      });
      document.body.appendChild(card);
      const acceptCard = ProfilePageAcceptCard.fromAcceptButton(acceptButton);
      expect(acceptCard?.name).toBe('Nirupama Nishtala');
    });
  });

  describe('.profileUrl', () => {
    it('derives the canonical profile URL from the page vanity', () => {
      setProfilePath('alice-doe');
      const { card, acceptButton } = makeProfilePage({
        vanity: 'alice-doe',
        name: 'Alice Doe',
      });
      document.body.appendChild(card);
      const acceptCard = ProfilePageAcceptCard.fromAcceptButton(acceptButton);
      expect(acceptCard?.profileUrl).toBe('https://www.linkedin.com/in/alice-doe');
    });
  });

  describe('.title', () => {
    it('returns the long headline <p> sibling of the name column', () => {
      setProfilePath('nishtalasn');
      const headline =
        'Ph.D. | R&D Program Manager & Scientific Writer | Pharma & Biotech | Managed 100+ partnerships';
      const { card, acceptButton } = makeProfilePage({
        vanity: 'nishtalasn',
        name: 'Nirupama Nishtala',
        pronouns: 'She/Her',
        headline,
        location: 'New York, New York, United States',
      });
      document.body.appendChild(card);
      const acceptCard = ProfilePageAcceptCard.fromAcceptButton(acceptButton);
      expect(acceptCard?.title).toBe(headline);
    });

    it('skips "She/Her" pronouns, "· 1st" degree markers, and location/contact-info noise', () => {
      setProfilePath('alice');
      const { card, acceptButton } = makeProfilePage({
        vanity: 'alice',
        name: 'Alice',
        pronouns: 'They/Them',
        headline: 'Staff Engineer at Stripe focused on payments infra',
        location: 'Brooklyn, New York',
      });
      document.body.appendChild(card);
      const acceptCard = ProfilePageAcceptCard.fromAcceptButton(acceptButton);
      expect(acceptCard?.title).toBe('Staff Engineer at Stripe focused on payments infra');
    });

    it('returns empty string when no headline <p> exists', () => {
      setProfilePath('bob');
      const { card, acceptButton } = makeProfilePage({
        vanity: 'bob',
        name: 'Bob',
        pronouns: 'He/Him',
      });
      document.body.appendChild(card);
      const acceptCard = ProfilePageAcceptCard.fromAcceptButton(acceptButton);
      expect(acceptCard?.title).toBe('');
    });
  });

  describe('.messageText', () => {
    it('returns empty string (profile-page accept has no invitation note)', () => {
      setProfilePath('alice');
      const { card, acceptButton } = makeProfilePage({ vanity: 'alice', name: 'Alice' });
      document.body.appendChild(card);
      const acceptCard = ProfilePageAcceptCard.fromAcceptButton(acceptButton);
      expect(acceptCard?.messageText).toBe('');
    });
  });
});
