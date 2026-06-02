// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import { SalesNavLeadCard } from '../../src/cards/sales-nav-lead-card.ts';

const LEAD_HREF = '/sales/lead/ACwAACbVAzwBJGEanU_FOMW-BHzyIE5mWL-cPfo,NAME_SEARCH,qJrX';
const LEAD_URL = 'https://www.linkedin.com/sales/lead/ACwAACbVAzwBJGEanU_FOMW-BHzyIE5mWL-cPfo';

/**
 * Builds a faithful-ish Sales Nav lead header (`section._header_sqh8tm`) using
 * the same stable hooks the real DOM exposes: data-anonymize fields,
 * data-x--lead--name, and the actions-bar markers. Hashed Ember classes are
 * omitted on purpose — the card must never depend on them.
 */
function makeLeadHeader(
  opts: {
    name?: string;
    headline?: string;
    company?: string;
    leadHref?: string;
    publicInHref?: string;
  } = {},
): { header: HTMLElement; saveButton: HTMLElement } {
  const name = opts.name ?? 'David Janotka';
  const headline = opts.headline ?? 'Founder & Managing Director at Web3 Recruit';
  const company = opts.company ?? 'Web3 Recruit';
  const leadHref = opts.leadHref ?? LEAD_HREF;

  const header = document.createElement('section');

  // Avatar link → /sales/lead
  const avatar = document.createElement('a');
  avatar.setAttribute('data-anonymize', 'headshot-photo');
  avatar.setAttribute('href', leadHref);
  avatar.appendChild(document.createElement('img'));
  header.appendChild(avatar);

  // Name block
  const nameBlock = document.createElement('div');
  const h1 = document.createElement('h1');
  h1.setAttribute('data-x--lead--name', '');
  h1.setAttribute('data-anonymize', 'person-name');
  const nameLink = document.createElement('a');
  nameLink.setAttribute('data-anonymize', 'person-name');
  nameLink.setAttribute('href', leadHref);
  nameLink.textContent = name;
  h1.appendChild(nameLink);
  nameBlock.appendChild(h1);
  const sublabel = document.createElement('span');
  sublabel.textContent = '(He/Him) · 2nd';
  nameBlock.appendChild(sublabel);
  header.appendChild(nameBlock);

  // Headline
  const headlineBlock = document.createElement('div');
  const headlineSpan = document.createElement('span');
  headlineSpan.setAttribute('data-anonymize', 'headline');
  headlineSpan.textContent = headline;
  headlineBlock.appendChild(headlineSpan);
  header.appendChild(headlineBlock);

  // Optional public /in/ link (present when a preview menu seeded it)
  if (opts.publicInHref) {
    const inLink = document.createElement('a');
    inLink.setAttribute('href', opts.publicInHref);
    inLink.textContent = 'View LinkedIn profile';
    header.appendChild(inLink);
  }

  // Company block
  const companyBlock = document.createElement('div');
  const companyLink = document.createElement('a');
  companyLink.setAttribute('href', '/sales/company/87222774');
  const companyImg = document.createElement('img');
  companyImg.setAttribute('data-anonymize', 'company-logo');
  companyImg.setAttribute('title', company);
  companyImg.setAttribute('alt', company);
  companyLink.appendChild(companyImg);
  companyBlock.appendChild(companyLink);
  header.appendChild(companyBlock);

  // Actions bar (Save / Message / overflow) — nested in its own <section>
  const actions = document.createElement('div');
  actions.setAttribute('data-x--lead--profile-card-actions', '');
  const actionsBar = document.createElement('section');
  actionsBar.setAttribute('data-x--lead-actions-bar', '');
  const saveButton = document.createElement('button');
  saveButton.setAttribute('aria-label', `Save ${name} as a lead. Save to list.`);
  saveButton.textContent = 'Save';
  actionsBar.appendChild(saveButton);
  const messageButton = document.createElement('button');
  messageButton.textContent = 'Message';
  actionsBar.appendChild(messageButton);
  actions.appendChild(actionsBar);
  header.appendChild(actions);

  return { header, saveButton };
}

describe('SalesNavLeadCard', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('.fromActionButton', () => {
    it('builds a card from a Save button nested in the actions-bar section', () => {
      const { header, saveButton } = makeLeadHeader();
      document.body.appendChild(header);
      // closest('section') from Save would reach the actions bar (no person-name);
      // the card must keep walking up to the header.
      expect(SalesNavLeadCard.fromActionButton(saveButton)).not.toBeNull();
    });

    it('returns null when the button is not inside a lead header', () => {
      const button = document.createElement('button');
      document.body.appendChild(button);
      expect(SalesNavLeadCard.fromActionButton(button)).toBeNull();
    });
  });

  describe('.fromDocument', () => {
    it('locates the header from the person-name field', () => {
      const { header } = makeLeadHeader();
      document.body.appendChild(header);
      expect(SalesNavLeadCard.fromDocument(document)).not.toBeNull();
    });

    it('returns null when no lead header exists', () => {
      expect(SalesNavLeadCard.fromDocument(document)).toBeNull();
    });
  });

  describe('.name', () => {
    it('reads the name link, excluding the pronoun/degree sublabel', () => {
      const { header } = makeLeadHeader({ name: 'David Janotka' });
      expect(new SalesNavLeadCard(header).name).toBe('David Janotka');
    });
  });

  describe('.title', () => {
    it('reads the headline field', () => {
      const { header } = makeLeadHeader({
        headline: 'Founder & Managing Director at Web3 Recruit',
      });
      expect(new SalesNavLeadCard(header).title).toBe(
        'Founder & Managing Director at Web3 Recruit',
      );
    });
  });

  describe('.company', () => {
    it('reads the company name from the company-logo title', () => {
      const { header } = makeLeadHeader({ company: 'Web3 Recruit' });
      expect(new SalesNavLeadCard(header).company).toBe('Web3 Recruit');
    });
  });

  describe('.profileUrl / .leadUrl', () => {
    it('returns the normalized lead URL (suffix stripped) when no public link', () => {
      const { header } = makeLeadHeader();
      const card = new SalesNavLeadCard(header);
      expect(card.leadUrl).toBe(LEAD_URL);
      expect(card.profileUrl).toBe(LEAD_URL);
    });

    it('prefers a public /in/ URL when one is present in the header', () => {
      const { header } = makeLeadHeader({
        publicInHref: 'https://www.linkedin.com/in/david-janotka-138226162',
      });
      const card = new SalesNavLeadCard(header);
      expect(card.profileUrl).toBe('https://www.linkedin.com/in/david-janotka-138226162');
      // leadUrl stays the Sales-Nav-native identifier
      expect(card.leadUrl).toBe(LEAD_URL);
    });
  });

  describe('.container', () => {
    it('returns the header element', () => {
      const { header } = makeLeadHeader();
      expect(new SalesNavLeadCard(header).container).toBe(header);
    });
  });
});
