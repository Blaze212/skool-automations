// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extract } from '../src/extract.js';
import { invalidateAvailabilityCache } from '../src/ai-fallback/availability.js';
import {
  installLanguageModel,
  uninstallLanguageModel,
} from '../../../tests/__mocks__/language-model.ts';

/**
 * Builds the My Network invitation card shape that AcceptInvitationCard
 * targets — a [role="listitem"] containing a profile link, a headline, and
 * an Accept/Ignore button pair.
 */
function makeMyNetworkCard(opts: {
  name: string;
  vanity: string;
  title: string;
  ariaLabel?: string;
}): { container: HTMLElement; acceptButton: HTMLElement } {
  const card = document.createElement('li');
  card.setAttribute('role', 'listitem');

  const avatarLink = document.createElement('a');
  avatarLink.href = `https://www.linkedin.com/in/${opts.vanity}/`;
  avatarLink.appendChild(document.createElement('img'));
  card.appendChild(avatarLink);

  const namePara = document.createElement('p');
  const nameLink = document.createElement('a');
  nameLink.href = `https://www.linkedin.com/in/${opts.vanity}/`;
  nameLink.textContent = opts.name;
  namePara.appendChild(nameLink);
  card.appendChild(namePara);

  const titleDiv = document.createElement('div');
  const titleSpan = document.createElement('span');
  titleSpan.textContent = opts.title;
  titleDiv.appendChild(titleSpan);
  card.appendChild(titleDiv);

  const acceptButton = document.createElement('button');
  acceptButton.setAttribute('aria-label', opts.ariaLabel ?? `Accept ${opts.name}'s invitation`);
  acceptButton.textContent = 'Accept';
  card.appendChild(acceptButton);

  document.body.appendChild(card);
  return { container: card, acceptButton };
}

/**
 * Builds the profile-page Accept-button shape. The orchestrator only fires
 * the profile-page card when the URL matches /in/{vanity}/ — tests set the
 * path via history.pushState.
 */
function makeProfilePageAccept(opts: { name: string; vanity: string; title: string }): {
  container: HTMLElement;
  acceptButton: HTMLElement;
} {
  window.history.pushState({}, '', `/in/${opts.vanity}/`);
  const section = document.createElement('section');

  const headingAnchor = document.createElement('a');
  headingAnchor.href = `https://www.linkedin.com/in/${opts.vanity}/`;
  const h2 = document.createElement('h2');
  h2.textContent = opts.name;
  headingAnchor.appendChild(h2);
  section.appendChild(headingAnchor);

  const titlePara = document.createElement('p');
  titlePara.textContent = opts.title;
  section.appendChild(titlePara);

  const acceptButton = document.createElement('button');
  acceptButton.setAttribute('aria-label', `Accept ${opts.name}'s invitation`);
  acceptButton.textContent = 'Accept';
  section.appendChild(acceptButton);

  document.body.appendChild(section);
  return { container: section, acceptButton };
}

describe('extract() — accepted_connection happy path', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('extracts a clean event from a My Network invitation card', async () => {
    const { acceptButton } = makeMyNetworkCard({
      name: 'Jane Doe',
      vanity: 'jane-doe',
      title: 'Senior Engineer at Acme — 10+ years scaling teams',
    });

    const result = await extract({
      document,
      target: acceptButton,
      pageUrl: 'https://www.linkedin.com/mynetwork/invitation-manager/',
      eventType: 'accepted_connection',
    });

    expect(result.source).toBe('selectors');
    expect(result.validation.dirty).toBe(false);
    expect(result.event).toMatchObject({
      api_key: '',
      event_type: 'accepted_connection',
      name: 'Jane Doe',
      title: 'Senior Engineer at Acme — 10+ years scaling teams',
      linkedin_url: 'https://www.linkedin.com/in/jane-doe',
      page_url: 'https://www.linkedin.com/mynetwork/invitation-manager/',
      message_text: '',
    });
    expect(result.event.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('extracts from a profile-page Accept button via the URL-anchored card', async () => {
    const { acceptButton } = makeProfilePageAccept({
      name: 'Alex Profile',
      vanity: 'alex-profile',
      title: 'Founder at Startupco — building distributed teams',
    });

    const result = await extract({
      document,
      target: acceptButton,
      pageUrl: 'https://www.linkedin.com/in/alex-profile/',
      eventType: 'accepted_connection',
    });

    expect(result.source).toBe('selectors');
    expect(result.validation.dirty).toBe(false);
    expect(result.event.name).toBe('Alex Profile');
    expect(result.event.linkedin_url).toBe('https://www.linkedin.com/in/alex-profile');
    expect(result.event.title).toContain('Founder at Startupco');
  });
});

describe('extract() — dirty paths', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('marks dirty when the click target has no matching card ancestor', async () => {
    // Bare button not inside a listitem and the URL isn't a profile page —
    // both card constructors return null, so the orchestrator yields an
    // empty event and validate() flags the required-field gaps.
    window.history.pushState({}, '', '/feed/');
    const button = document.createElement('button');
    button.setAttribute('aria-label', 'Accept invitation');
    document.body.appendChild(button);

    const result = await extract({
      document,
      target: button,
      pageUrl: 'https://www.linkedin.com/feed/',
      eventType: 'accepted_connection',
    });

    expect(result.validation.dirty).toBe(true);
    const codes = result.validation.gaps.map((g) => `${g.field}:${g.code}`);
    expect(codes).toContain('name:missing-required');
    expect(codes).toContain('linkedin_url:missing-required');
    expect(codes).toContain('title:missing-required');
  });

  it('flags a degree-marker leak in a captured title', async () => {
    // Title with "· 1st" trailing — the cards don't always strip this and
    // validate() catches it before the event ships.
    const { acceptButton } = makeMyNetworkCard({
      name: 'Pat Person',
      vanity: 'pat-person',
      title: 'Director of Engineering · 1st',
    });

    const result = await extract({
      document,
      target: acceptButton,
      pageUrl: 'https://www.linkedin.com/mynetwork/invitation-manager/',
      eventType: 'accepted_connection',
    });

    expect(result.validation.dirty).toBe(true);
    const codes = result.validation.gaps.map((g) => `${g.field}:${g.code}`);
    expect(codes).toContain('title:noise-degree-marker');
    // Name/url still clean — only title is dirty.
    expect(codes).not.toContain('name:missing-required');
    expect(codes).not.toContain('linkedin_url:missing-required');
  });
});

describe('extract() — guard rails', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('throws for non-accepted_connection eventTypes (phase 4 scope limit)', async () => {
    const button = document.createElement('button');
    await expect(
      extract({
        document,
        target: button,
        pageUrl: 'https://www.linkedin.com/feed/',
        // @ts-expect-error — intentionally passing an out-of-scope hint to
        // assert the runtime guard works alongside the type-level guard.
        eventType: 'direct_message',
      }),
    ).rejects.toThrow(/does not yet support/);
  });

  it('does not consult the model for a clean event even with AI enabled', async () => {
    const { acceptButton } = makeMyNetworkCard({
      name: 'Riley',
      vanity: 'riley',
      title: 'Product designer focused on developer tools',
    });

    const result = await extract({
      document,
      target: acceptButton,
      pageUrl: 'https://www.linkedin.com/mynetwork/invitation-manager/',
      eventType: 'accepted_connection',
      aiOptions: { enabled: true, timeoutMs: 1500 },
    });

    // Clean event ⇒ validate().dirty === false ⇒ recover() is never invoked.
    expect(result.source).toBe('selectors');
    expect(result.event.name).toBe('Riley');
  });
});

describe('extract() — AI fallback (spec 013)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    invalidateAvailabilityCache();
  });

  afterEach(() => {
    uninstallLanguageModel();
    invalidateAvailabilityCache();
  });

  // A My Network card whose title carries a "· 1st" degree-marker leak —
  // validate() flags it as dirty, which is the trigger condition for recovery.
  function makeDirtyCard(): HTMLElement {
    const { acceptButton } = makeMyNetworkCard({
      name: 'Jane Doe',
      vanity: 'jane-doe',
      title: 'Director of Engineering · 1st',
    });
    return acceptButton;
  }

  it('repairs a dirty event and stamps source="ai-recovered" when the model is available', async () => {
    installLanguageModel({
      availability: 'available',
      promptResult: JSON.stringify({
        name: 'Jane Doe',
        title: 'Head of Growth at Acme',
        linkedin_url: 'https://www.linkedin.com/in/jane-doe/',
        message_text: null,
      }),
    });

    const result = await extract({
      document,
      target: makeDirtyCard(),
      pageUrl: 'https://www.linkedin.com/mynetwork/invitation-manager/',
      eventType: 'accepted_connection',
      aiOptions: { enabled: true },
    });

    expect(result.source).toBe('ai-recovered');
    expect(result.event.title).toBe('Head of Growth at Acme');
    expect(result.recoveredHtml).toBeTruthy();
  });

  it('stays selectors-only when AI is disabled', async () => {
    installLanguageModel({ availability: 'available' });
    const result = await extract({
      document,
      target: makeDirtyCard(),
      pageUrl: 'https://www.linkedin.com/mynetwork/invitation-manager/',
      eventType: 'accepted_connection',
      aiOptions: { enabled: false },
    });
    expect(result.source).toBe('selectors');
    expect(result.recoveredHtml).toBeUndefined();
  });

  it('stays selectors-only when the model is unavailable', async () => {
    installLanguageModel({ availability: 'unavailable' });
    const result = await extract({
      document,
      target: makeDirtyCard(),
      pageUrl: 'https://www.linkedin.com/mynetwork/invitation-manager/',
      eventType: 'accepted_connection',
      aiOptions: { enabled: true },
    });
    expect(result.source).toBe('selectors');
    expect(result.recoveredHtml).toBeUndefined();
  });

  it('stays selectors-only when recover() returns null (model error)', async () => {
    installLanguageModel({ availability: 'available', promptThrows: true });
    const result = await extract({
      document,
      target: makeDirtyCard(),
      pageUrl: 'https://www.linkedin.com/mynetwork/invitation-manager/',
      eventType: 'accepted_connection',
      aiOptions: { enabled: true },
    });
    expect(result.source).toBe('selectors');
    expect(result.recoveredHtml).toBeUndefined();
  });
});
