/**
 * Encapsulates data extraction for a LinkedIn message chat — both the small
 * chat-overlay bubble in the bottom-right of any page AND the full messenger
 * thread page.
 *
 * Card boundary: the smallest ancestor of the composer that also contains either
 * the overlay header (`h2.msg-overlay-bubble-header__title`) or the recipient
 * profile card (`.msg-s-profile-card`). Scoping by ancestor — not by document
 * lookup — keeps multi-chat-bubble scenarios correct and, critically, keeps
 * title extraction *out of the message list* so a URL the recipient sent can
 * never leak into the title field.
 */

function normalizeLinkedInUrl(url: string): string {
  if (!url) return '';
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    const m = u.pathname.match(/^(\/in\/[^/?#]+)/);
    if (!m) return url;
    return `https://www.linkedin.com${m[1]}`;
  } catch {
    return url;
  }
}

export class ChatOverlayCard {
  constructor(private readonly card: HTMLElement) {}

  /**
   * Walks up from the composer (contenteditable element) to the smallest
   * ancestor containing the chat overlay header or the recipient profile card.
   * Returns null if neither marker is reachable from the composer.
   */
  static fromComposer(composer: HTMLElement): ChatOverlayCard | null {
    let n: HTMLElement | null = composer.parentElement;
    while (n) {
      if (
        n.querySelector('h2.msg-overlay-bubble-header__title') ||
        n.querySelector('.msg-s-profile-card')
      ) {
        return new ChatOverlayCard(n);
      }
      if (n === document.documentElement) break;
      n = n.parentElement;
    }
    return null;
  }

  private get profileCard(): HTMLElement | null {
    return this.card.querySelector('.msg-s-profile-card');
  }

  private get headerTitle(): HTMLElement | null {
    return this.card.querySelector('h2.msg-overlay-bubble-header__title');
  }

  get name(): string {
    // Prefer the profile card title — least noisy structure.
    const card = this.profileCard;
    if (card) {
      const titleEl = card.querySelector('.artdeco-entity-lockup__title') as HTMLElement | null;
      const link = (titleEl ?? card).querySelector(
        'a[href*="/in/"]',
      ) as HTMLAnchorElement | null;
      if (link) {
        // The name link wraps a <span> with the clean name and may include a
        // badge <svg>. Take the inner span text — fall back to link text.
        const span = link.querySelector('span');
        const text = (span?.textContent ?? link.textContent ?? '').trim();
        if (text) return text;
      }
    }
    // Fallback: chat-overlay header h2 contains <a><span>Name</span></a>.
    const header = this.headerTitle;
    if (header) {
      const span = header.querySelector('a span') ?? header.querySelector('span');
      const text = (span?.textContent ?? header.textContent ?? '').trim();
      if (text) return text;
    }
    return '';
  }

  /**
   * Headline / subtitle. ONLY sourced from the recipient profile card —
   * the chat overlay header carries the name but no headline, and scanning
   * the message thread for a headline would risk picking up message-body
   * text (URLs, snippets, article titles).
   */
  get title(): string {
    const card = this.profileCard;
    if (!card) return '';
    const subtitle = card.querySelector(
      '.artdeco-entity-lockup__subtitle',
    ) as HTMLElement | null;
    if (!subtitle) return '';
    // [title] attribute holds the untruncated string when LinkedIn renders a
    // tooltip-on-hover variant; prefer it when present.
    const inner = subtitle.querySelector('[title]') as HTMLElement | null;
    const fromAttr = inner?.getAttribute('title')?.trim() ?? '';
    if (fromAttr) return fromAttr;
    return subtitle.textContent?.trim() ?? '';
  }

  get profileUrl(): string {
    const card = this.profileCard;
    if (card) {
      const links = Array.from(card.querySelectorAll('a[href*="/in/"]')) as HTMLAnchorElement[];
      const preferred = links.find((a) => !a.querySelector('img')) ?? links[0] ?? null;
      if (preferred) return normalizeLinkedInUrl(preferred.href);
    }
    const header = this.headerTitle;
    const headerLink = header?.querySelector('a[href*="/in/"]') as HTMLAnchorElement | null;
    if (headerLink) return normalizeLinkedInUrl(headerLink.href);
    return '';
  }

  get container(): HTMLElement {
    return this.card;
  }
}
