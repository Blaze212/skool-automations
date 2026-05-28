// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProfilePageOwnerCard } from '../../../linkedin-tracker/src/profile-page-owner-card.ts';

function setProfilePath(vanity: string): void {
  window.history.pushState({}, '', `/in/${vanity}/`);
}

function makeProfilePage(opts: {
  vanity: string;
  name: string;
  pronouns?: string;
  headline?: string;
  location?: string;
}): HTMLElement {
  const main = document.createElement('main');
  const card = document.createElement('section');
  main.appendChild(card);

  const block = document.createElement('div');
  card.appendChild(block);

  const nameCol = document.createElement('div');
  block.appendChild(nameCol);

  const headingWrap = document.createElement('div');
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

  if (opts.headline) {
    const headlineP = document.createElement('p');
    headlineP.textContent = opts.headline;
    block.appendChild(headlineP);
  }

  if (opts.location) {
    const locP = document.createElement('p');
    locP.textContent = opts.location;
    block.appendChild(locP);
  }

  return main;
}

describe('ProfilePageOwnerCard', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    setProfilePath('default');
  });

  afterEach(() => {
    window.history.pushState({}, '', '/');
  });

  describe('.fromCurrentUrl', () => {
    it('returns a ProfilePageOwnerCard when on /in/{vanity}/ and a heading anchor exists', () => {
      setProfilePath('taniahansraj');
      document.body.appendChild(makeProfilePage({ vanity: 'taniahansraj', name: 'Tania Hansraj' }));
      expect(ProfilePageOwnerCard.fromCurrentUrl()).not.toBeNull();
    });

    it('returns null when current page is not a profile page', () => {
      window.history.pushState({}, '', '/feed/');
      document.body.appendChild(makeProfilePage({ vanity: 'taniahansraj', name: 'Tania Hansraj' }));
      expect(ProfilePageOwnerCard.fromCurrentUrl()).toBeNull();
    });

    it('returns null when no heading anchor for the URL vanity exists in the document', () => {
      setProfilePath('orphan');
      // A heading for a different vanity should not satisfy the lookup
      document.body.appendChild(makeProfilePage({ vanity: 'someone-else', name: 'Someone Else' }));
      expect(ProfilePageOwnerCard.fromCurrentUrl()).toBeNull();
    });
  });

  describe('.name', () => {
    it('extracts the name from the <h2> inside the heading anchor', () => {
      setProfilePath('taniahansraj');
      document.body.appendChild(makeProfilePage({ vanity: 'taniahansraj', name: 'Tania Hansraj' }));
      expect(ProfilePageOwnerCard.fromCurrentUrl()?.name).toBe('Tania Hansraj');
    });
  });

  describe('.profileUrl', () => {
    it('derives the canonical URL from the page vanity', () => {
      setProfilePath('alice-doe');
      document.body.appendChild(makeProfilePage({ vanity: 'alice-doe', name: 'Alice Doe' }));
      expect(ProfilePageOwnerCard.fromCurrentUrl()?.profileUrl).toBe(
        'https://www.linkedin.com/in/alice-doe',
      );
    });
  });

  describe('.title', () => {
    it('returns the headline <p> sibling of the name column', () => {
      setProfilePath('alice');
      const headline = 'Staff Engineer at Stripe focused on payments infra';
      document.body.appendChild(
        makeProfilePage({
          vanity: 'alice',
          name: 'Alice',
          pronouns: 'She/Her',
          headline,
          location: 'Brooklyn, New York',
        }),
      );
      expect(ProfilePageOwnerCard.fromCurrentUrl()?.title).toBe(headline);
    });

    it('skips pronouns, "· 1st" degree markers, and short noise', () => {
      setProfilePath('bob');
      document.body.appendChild(
        makeProfilePage({
          vanity: 'bob',
          name: 'Bob',
          pronouns: 'They/Them',
          headline: 'Founder, ex-Stripe, ex-Square',
        }),
      );
      expect(ProfilePageOwnerCard.fromCurrentUrl()?.title).toBe('Founder, ex-Stripe, ex-Square');
    });

    it('returns empty string when no headline exists', () => {
      setProfilePath('cleo');
      document.body.appendChild(
        makeProfilePage({ vanity: 'cleo', name: 'Cleo', pronouns: 'She/Her' }),
      );
      expect(ProfilePageOwnerCard.fromCurrentUrl()?.title).toBe('');
    });
  });
});
