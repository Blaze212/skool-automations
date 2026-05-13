// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleConnectionRequest,
  handleDirectMessage,
  resetDedup,
} from '../../../linkedin-tracker/src/content.ts';
import type { TrackerEvent } from '../../../linkedin-tracker/src/types.ts';

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

function makeDmButton(name: string, title: string, messageText: string): HTMLButtonElement {
  const nameEl = document.createElement('div');
  nameEl.className = 'msg-entity-lockup__entity-title';
  nameEl.textContent = name;
  document.body.appendChild(nameEl);

  const titleEl = document.createElement('div');
  titleEl.className = 'msg-entity-lockup__subtitle';
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
  });
});
