// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import { SalesNavConnectModalCard } from '../../src/cards/sales-nav-connect-modal-card.ts';

/**
 * Builds the Sales Nav "Send invitation" modal using the stable hooks the real
 * DOM exposes: #connect-cta-form__header, data-sn-view-name, the
 * data-anonymize person-name lockup, and the #connect-cta-form__invitation
 * textarea.
 */
function makeConnectModal(opts: { name?: string; note?: string } = {}): {
  modal: HTMLElement;
  sendButton: HTMLElement;
} {
  const name = opts.name ?? 'David Janotka';

  const modal = document.createElement('div');
  modal.setAttribute('data-test-modal', '');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-labelledby', 'connect-cta-form__header');

  const heading = document.createElement('h2');
  heading.id = 'connect-cta-form__header';
  heading.textContent = 'Send invitation';
  modal.appendChild(heading);

  const content = document.createElement('div');
  content.setAttribute('data-sn-view-name', 'subpage-connect-modal');

  const lockup = document.createElement('div');
  const nameEl = document.createElement('div');
  nameEl.setAttribute('data-anonymize', 'person-name');
  nameEl.textContent = name;
  lockup.appendChild(nameEl);
  const degree = document.createElement('span');
  degree.setAttribute('aria-label', 'Second-degree connection');
  degree.textContent = '· 2nd';
  lockup.appendChild(degree);
  content.appendChild(lockup);

  const textarea = document.createElement('textarea');
  textarea.id = 'connect-cta-form__invitation';
  textarea.maxLength = 300;
  if (opts.note !== undefined) textarea.value = opts.note;
  content.appendChild(textarea);
  modal.appendChild(content);

  const actionbar = document.createElement('div');
  actionbar.setAttribute('data-sn-view-name', 'subpage-connect-modal');
  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  actionbar.appendChild(cancel);
  const sendButton = document.createElement('button');
  sendButton.className = 'button-primary-medium connect-cta-form__send';
  sendButton.textContent = 'Send Invitation';
  actionbar.appendChild(sendButton);
  modal.appendChild(actionbar);

  return { modal, sendButton };
}

describe('SalesNavConnectModalCard', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('.fromSendButton', () => {
    it('builds a card from the Send Invitation button', () => {
      const { modal, sendButton } = makeConnectModal();
      document.body.appendChild(modal);
      expect(SalesNavConnectModalCard.fromSendButton(sendButton)).not.toBeNull();
    });

    it('returns null when the dialog is not the connect modal', () => {
      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      const btn = document.createElement('button');
      btn.textContent = 'OK';
      dialog.appendChild(btn);
      document.body.appendChild(dialog);
      expect(SalesNavConnectModalCard.fromSendButton(btn)).toBeNull();
    });

    it('returns null when the button has no dialog ancestor', () => {
      const btn = document.createElement('button');
      document.body.appendChild(btn);
      expect(SalesNavConnectModalCard.fromSendButton(btn)).toBeNull();
    });
  });

  describe('.fromDocument', () => {
    it('locates the connect modal among multiple dialogs', () => {
      const other = document.createElement('div');
      other.setAttribute('role', 'dialog');
      document.body.appendChild(other);
      const { modal } = makeConnectModal();
      document.body.appendChild(modal);
      expect(SalesNavConnectModalCard.fromDocument(document)).not.toBeNull();
    });
  });

  describe('.name', () => {
    it('reads the recipient name, excluding the degree badge', () => {
      const { modal } = makeConnectModal({ name: 'David Janotka' });
      expect(new SalesNavConnectModalCard(modal).name).toBe('David Janotka');
    });
  });

  describe('.messageText', () => {
    it('returns the typed personal note', () => {
      const { modal } = makeConnectModal({ note: 'Hi David, would love to connect!' });
      expect(new SalesNavConnectModalCard(modal).messageText).toBe(
        'Hi David, would love to connect!',
      );
    });

    it('returns empty string when no note was typed (placeholder is not the value)', () => {
      const { modal } = makeConnectModal();
      expect(new SalesNavConnectModalCard(modal).messageText).toBe('');
    });
  });

  describe('empty fields', () => {
    it('title and profileUrl are empty (the modal carries neither)', () => {
      const { modal } = makeConnectModal();
      const card = new SalesNavConnectModalCard(modal);
      expect(card.title).toBe('');
      expect(card.profileUrl).toBe('');
    });
  });
});
