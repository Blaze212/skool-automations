// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import { SalesNavMenuCard } from '../../src/cards/sales-nav-menu-card.ts';

const LEAD_HREF = '/sales/lead/ACwAAACIz7IBa-hC9NS4oIq_8AciM7Oo_gai1BE,NAME_SEARCH,CFou';
const LEAD_URL = 'https://www.linkedin.com/sales/lead/ACwAAACIz7IBa-hC9NS4oIq_8AciM7Oo_gai1BE';

/** li > button menu item. */
function buttonItem(text: string): HTMLElement {
  const li = document.createElement('li');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = text;
  li.appendChild(btn);
  return li;
}

/** li > a menu item. */
function linkItem(text: string, href: string, attrs: Record<string, string> = {}): HTMLElement {
  const li = document.createElement('li');
  const a = document.createElement('a');
  a.setAttribute('href', href);
  a.textContent = text;
  for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
  li.appendChild(a);
  return li;
}

/** Search-result row "…" menu: Connect / View profile / Edit list / Unsave / Add to map. */
function makeConnectDropdown(): { menu: HTMLElement; connectButton: HTMLElement } {
  const menu = document.createElement('ul');
  const connectLi = buttonItem('Connect');
  menu.appendChild(connectLi);
  menu.appendChild(
    linkItem('View profile', LEAD_HREF, {
      'data-control-name': 'view_profile_via_result_menu',
    }),
  );
  menu.appendChild(buttonItem('Edit list'));
  menu.appendChild(buttonItem('Unsave'));
  menu.appendChild(buttonItem('Add to map'));
  return { menu, connectButton: connectLi.querySelector('button')! };
}

/** Profile preview menu: Connect / View Profile / Add note / View LinkedIn profile / Copy URL. */
function makePreviewMenu(): { menu: HTMLElement; connectButton: HTMLElement } {
  const menu = document.createElement('ul');
  const connectLi = buttonItem('Connect');
  menu.appendChild(connectLi);
  menu.appendChild(linkItem('View Profile', LEAD_HREF, { target: '_blank' }));
  menu.appendChild(buttonItem('Add note'));
  menu.appendChild(
    linkItem('View LinkedIn profile', 'https://www.linkedin.com/in/david-janotka-138226162', {
      target: '_blank',
    }),
  );
  menu.appendChild(buttonItem('Copy LinkedIn.com URL'));
  return { menu, connectButton: connectLi.querySelector('button')! };
}

describe('SalesNavMenuCard', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('.fromMenuItem', () => {
    it('builds a card from a Connect button inside a person menu', () => {
      const { menu, connectButton } = makeConnectDropdown();
      document.body.appendChild(menu);
      expect(SalesNavMenuCard.fromMenuItem(connectButton)).not.toBeNull();
    });

    it('returns null for a menu with no lead/profile link', () => {
      const menu = document.createElement('ul');
      const item = buttonItem('Some unrelated action');
      menu.appendChild(item);
      document.body.appendChild(menu);
      expect(SalesNavMenuCard.fromMenuItem(item.querySelector('button')!)).toBeNull();
    });
  });

  describe('.profileUrl', () => {
    it('returns the normalized lead URL on the connect dropdown (no public link)', () => {
      const { menu, connectButton } = makeConnectDropdown();
      const card = SalesNavMenuCard.fromMenuItem(connectButton)!;
      void menu;
      expect(card.profileUrl).toBe(LEAD_URL);
      expect(card.leadUrl).toBe(LEAD_URL);
    });

    it('prefers the public /in/ URL on the preview menu', () => {
      const { connectButton } = makePreviewMenu();
      const card = SalesNavMenuCard.fromMenuItem(connectButton)!;
      expect(card.profileUrl).toBe('https://www.linkedin.com/in/david-janotka-138226162');
      expect(card.leadUrl).toBe(LEAD_URL);
    });
  });

  describe('empty fields', () => {
    it('name, title, messageText are empty (the menu carries none)', () => {
      const { connectButton } = makeConnectDropdown();
      const card = SalesNavMenuCard.fromMenuItem(connectButton)!;
      expect(card.name).toBe('');
      expect(card.title).toBe('');
      expect(card.messageText).toBe('');
    });
  });
});
