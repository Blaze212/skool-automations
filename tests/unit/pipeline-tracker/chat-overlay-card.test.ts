// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ChatOverlayCard } from '../../../pipeline-tracker/src/chat-overlay-card.ts';

const FIXTURE_DIR = join(__dirname, '../../../pipeline-tracker/test-divs');

function loadFixture(name: string): void {
  const html = readFileSync(join(FIXTURE_DIR, name), 'utf-8');
  document.body.innerHTML = html;
}

function getComposer(): HTMLElement {
  const composer = document.querySelector('[contenteditable="true"]') as HTMLElement | null;
  if (!composer) throw new Error('test fixture missing contenteditable composer');
  return composer;
}

describe('ChatOverlayCard', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('small-chat.txt — Katie McIntyre (no profile card, header only)', () => {
    // Regression: previous extractor walked from the composer into the message
    // list and pulled a URL out of a <p class="msg-s-event-listitem__body">,
    // setting title to a long URL string. Title must never be a URL.
    it('extracts name from chat header h2 when no profile card is present', () => {
      loadFixture('small-chat.txt');
      const card = ChatOverlayCard.fromComposer(getComposer());
      expect(card).not.toBeNull();
      expect(card!.name).toBe('Katie McIntyre');
    });

    it('returns empty title when no profile card is rendered (never a URL)', () => {
      loadFixture('small-chat.txt');
      const card = ChatOverlayCard.fromComposer(getComposer())!;
      expect(card.title).toBe('');
      expect(card.title).not.toMatch(/^https?:\/\//);
      expect(card.title).not.toMatch(/linkedin\.com/);
    });

    it('extracts profile URL from the header link', () => {
      loadFixture('small-chat.txt');
      const card = ChatOverlayCard.fromComposer(getComposer())!;
      expect(card.profileUrl).toBe(
        'https://www.linkedin.com/in/ACoAABxaDfgB32shzB4DQpdhj9hCxFZvKUhDluQ',
      );
    });
  });

  describe('small-chat-2.txt — Nirupama Nishtala (header + profile card with subtitle)', () => {
    it('extracts name from the profile card title span', () => {
      loadFixture('small-chat-2.txt');
      const card = ChatOverlayCard.fromComposer(getComposer())!;
      expect(card.name).toBe('Nirupama Nishtala');
    });

    it('extracts the full untruncated headline from the subtitle [title] attribute', () => {
      loadFixture('small-chat-2.txt');
      const card = ChatOverlayCard.fromComposer(getComposer())!;
      expect(card.title).toBe(
        'Ph.D. | R&D Program Manager & Scientific Writer| Pharma & Biotech| Managed 100+ external academic and industry partnerships across 50+ concurrent programs in oncology, immunology, and rare disease',
      );
      expect(card.title).not.toMatch(/^https?:\/\//);
    });

    it('extracts profile URL from the profile card link', () => {
      loadFixture('small-chat-2.txt');
      const card = ChatOverlayCard.fromComposer(getComposer())!;
      expect(card.profileUrl).toBe(
        'https://www.linkedin.com/in/ACoAAATpAXIB0DSc4ndlXDxHBlP65n_V8vcMtpk',
      );
    });
  });

  describe('small-chat-3.txt — Mark Binns (header + profile card, no premium badge)', () => {
    it('extracts name from the profile card title span', () => {
      loadFixture('small-chat-3.txt');
      const card = ChatOverlayCard.fromComposer(getComposer())!;
      expect(card.name).toBe('Mark Binns');
    });

    it('extracts the short headline from the subtitle', () => {
      loadFixture('small-chat-3.txt');
      const card = ChatOverlayCard.fromComposer(getComposer())!;
      expect(card.title).toBe('Actively Looking and Open to New Opportunities');
      expect(card.title).not.toMatch(/^https?:\/\//);
    });

    it('extracts profile URL from the profile card link', () => {
      loadFixture('small-chat-3.txt');
      const card = ChatOverlayCard.fromComposer(getComposer())!;
      expect(card.profileUrl).toBe(
        'https://www.linkedin.com/in/ACoAAAOvPEsBTCwKeg3ZpxCWSywLPB6VnyGcBC4',
      );
    });
  });

  describe('synthetic edge cases', () => {
    it('returns null when composer has no chat header or profile card above it', () => {
      const composer = document.createElement('div');
      composer.setAttribute('contenteditable', 'true');
      document.body.appendChild(composer);
      expect(ChatOverlayCard.fromComposer(composer)).toBeNull();
    });

    it('never uses message body <p> text as title — even when a /in/ URL is inside', () => {
      // Minimal repro of the small-chat.txt failure mode: header with name,
      // and a message body containing a /in/ URL.
      document.body.innerHTML = `
        <header>
          <h2 class="msg-overlay-bubble-header__title">
            <a href="/in/some-vanity/"><span>Jane Doe</span></a>
          </h2>
        </header>
        <ul class="msg-s-message-list-content">
          <li>
            <p class="msg-s-event-listitem__body">
              <a href="https://www.linkedin.com/in/other-person/">
                https://www.linkedin.com/in/other-person/
              </a>
            </p>
          </li>
        </ul>
        <form><div contenteditable="true"></div></form>
      `;
      const card = ChatOverlayCard.fromComposer(getComposer())!;
      expect(card.name).toBe('Jane Doe');
      expect(card.title).toBe(''); // not the URL from the message body
      expect(card.profileUrl).toBe('https://www.linkedin.com/in/some-vanity');
    });
  });
});
