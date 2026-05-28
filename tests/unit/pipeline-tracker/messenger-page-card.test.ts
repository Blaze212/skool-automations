// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { MessengerPageCard } from '../../../pipeline-tracker/src/messenger-page-card.ts';

const FIXTURE_DIR = join(__dirname, '../../../pipeline-tracker/test-divs');

function loadFixture(name: string): void {
  const html = readFileSync(join(FIXTURE_DIR, name), 'utf-8');
  document.body.innerHTML = html;
}

describe('MessengerPageCard', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('messenger-page.txt — Alice Anderson (title bar only, no profile card)', () => {
    // Regression: this is the fixture where Strategy 1 (profile-card lookup)
    // fails and the legacy fallback would walk up from the composer and
    // concatenate "Alice Anderson Status is offline I like helping people:)"
    // into the name field.
    it('extracts name from the title bar entity-title h2', () => {
      loadFixture('messenger-page.txt');
      const card = MessengerPageCard.fromDocument()!;
      expect(card).not.toBeNull();
      expect(card.name).toBe('Alice Anderson');
    });

    it('extracts the headline from entity-info, stripping the presence indicator', () => {
      loadFixture('messenger-page.txt');
      const card = MessengerPageCard.fromDocument()!;
      expect(card.title).toBe('I like helping people:)');
      expect(card.title).not.toMatch(/Status is offline/);
    });

    it('extracts profile URL from the title bar anchor', () => {
      loadFixture('messenger-page.txt');
      const card = MessengerPageCard.fromDocument()!;
      expect(card.profileUrl).toBe(
        'https://www.linkedin.com/in/ACoAATEST0000000000000000000000000000001',
      );
    });
  });

  describe('messenger-page-2.txt — Casey Carter (title bar + profile card with full subtitle)', () => {
    it('prefers the profile card name over the title bar h2', () => {
      loadFixture('messenger-page-2.txt');
      const card = MessengerPageCard.fromDocument()!;
      expect(card.name).toBe('Casey Carter');
    });

    it('prefers the full untruncated subtitle from the profile card [title] attribute', () => {
      loadFixture('messenger-page-2.txt');
      const card = MessengerPageCard.fromDocument()!;
      expect(card.title).toBe(
        'Test long subtitle | with multiple pipe segments | including extra detail to verify full untruncated extraction across 50+ chars and beyond',
      );
    });

    it('returns the canonical profile URL', () => {
      loadFixture('messenger-page-2.txt');
      const card = MessengerPageCard.fromDocument()!;
      expect(card.profileUrl).toBe(
        'https://www.linkedin.com/in/ACoAATEST0000000000000000000000000000002',
      );
    });
  });

  describe('messenger-page-3.txt — Dan Davis (title bar + profile card)', () => {
    it('extracts name from the profile card', () => {
      loadFixture('messenger-page-3.txt');
      const card = MessengerPageCard.fromDocument()!;
      expect(card.name).toBe('Dan Davis');
    });

    it('extracts the headline from the profile card subtitle', () => {
      loadFixture('messenger-page-3.txt');
      const card = MessengerPageCard.fromDocument()!;
      expect(card.title).toBe('Technology Leader | Fractional CTO | SaaS Business Owner | Advisor');
    });

    it('returns the canonical profile URL', () => {
      loadFixture('messenger-page-3.txt');
      const card = MessengerPageCard.fromDocument()!;
      expect(card.profileUrl).toBe(
        'https://www.linkedin.com/in/ACoAATEST0000000000000000000000000000004',
      );
    });
  });

  describe('synthetic edge cases', () => {
    it('returns null when neither a profile card nor a title bar exists', () => {
      document.body.innerHTML = '<div><form><div contenteditable="true"></div></form></div>';
      expect(MessengerPageCard.fromDocument()).toBeNull();
    });

    it('falls back to title bar when profile card has no usable name/subtitle', () => {
      document.body.innerHTML = `
        <a class="msg-thread__link-to-profile" href="https://www.linkedin.com/in/jane-doe/">
          <div class="msg-entity-lockup">
            <h2 class="msg-entity-lockup__entity-title">Jane Doe</h2>
            <dd class="msg-entity-lockup__entity-info">
              <div class="msg-entity-lockup__presence-indicator">
                <span class="visually-hidden">Status is online</span>
              </div>
              Senior Engineer at ExampleCo
            </dd>
          </div>
        </a>
      `;
      const card = MessengerPageCard.fromDocument()!;
      expect(card.name).toBe('Jane Doe');
      expect(card.title).toBe('Senior Engineer at ExampleCo');
      expect(card.profileUrl).toBe('https://www.linkedin.com/in/jane-doe');
    });
  });
});
