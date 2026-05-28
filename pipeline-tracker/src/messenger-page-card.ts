/**
 * Extracts recipient data from the full LinkedIn messenger page
 * (`/messaging/thread/{id}/`).
 *
 * Two distinct DOM regions can carry the recipient's name & headline:
 *  1. `.msg-s-profile-card` at the top of the message list — when present,
 *     this carries a clean name (profile-card-one-to-one__profile-link span)
 *     and the full untruncated headline (artdeco-entity-lockup__subtitle div
 *     with [title] attr).
 *  2. `.msg-title-bar` header — always present. Carries the name in
 *     `h2.msg-entity-lockup__entity-title` and the headline as a text node
 *     inside `dd.msg-entity-lockup__entity-info` (alongside a hidden presence
 *     indicator that must be stripped).
 *
 * The profile card source is preferred when both exist because it includes
 * the full untruncated headline; the title bar is the fallback when the
 * profile card is not rendered (e.g., long active threads).
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

export class MessengerPageCard {
  private constructor(
    private readonly profileCard: HTMLElement | null,
    private readonly titleBarAnchor: HTMLAnchorElement | null,
  ) {}

  /**
   * Finds the recipient context on a full messenger page. Returns null if
   * neither the profile card nor the title bar header is present — meaning
   * we're not on a recognisable messenger page.
   */
  static fromDocument(): MessengerPageCard | null {
    const profileCard = document.querySelector('.msg-s-profile-card') as HTMLElement | null;
    const titleBarAnchor = document.querySelector(
      'a.msg-thread__link-to-profile',
    ) as HTMLAnchorElement | null;
    if (!profileCard && !titleBarAnchor) return null;
    return new MessengerPageCard(profileCard, titleBarAnchor);
  }

  get name(): string {
    if (this.profileCard) {
      const titleEl = this.profileCard.querySelector(
        '.artdeco-entity-lockup__title',
      ) as HTMLElement | null;
      const link = (titleEl ?? this.profileCard).querySelector(
        'a[href*="/in/"]',
      ) as HTMLAnchorElement | null;
      if (link) {
        const span = link.querySelector('span');
        const text = (span?.textContent ?? link.textContent ?? '').trim();
        if (text) return text;
      }
    }
    if (this.titleBarAnchor) {
      const h2 = this.titleBarAnchor.querySelector(
        '.msg-entity-lockup__entity-title',
      ) as HTMLElement | null;
      const text = h2?.textContent?.trim() ?? '';
      if (text) return text;
    }
    return '';
  }

  get title(): string {
    if (this.profileCard) {
      const subtitle = this.profileCard.querySelector(
        '.artdeco-entity-lockup__subtitle',
      ) as HTMLElement | null;
      if (subtitle) {
        // The inner div carries the full string as a [title] attribute so the
        // tooltip can show untruncated text on hover. Prefer that over
        // textContent (which may be the CSS-truncated visible form).
        const inner = subtitle.querySelector('[title]') as HTMLElement | null;
        const fromAttr = inner?.getAttribute('title')?.trim() ?? '';
        if (fromAttr) return fromAttr;
        const text = subtitle.textContent?.trim() ?? '';
        if (text) return text;
      }
    }
    if (this.titleBarAnchor) {
      // `dd.msg-entity-lockup__entity-info` contains a presence indicator div
      // (with visually-hidden "Status is offline") followed by a free-floating
      // text node with the headline. Strip the indicator before reading text.
      const info = this.titleBarAnchor.querySelector(
        '.msg-entity-lockup__entity-info',
      ) as HTMLElement | null;
      if (info) {
        const clone = info.cloneNode(true) as HTMLElement;
        clone
          .querySelectorAll(
            '.msg-entity-lockup__presence-indicator, .msg-entity-lockup__presence-status .visually-hidden',
          )
          .forEach((el) => el.remove());
        const text = clone.textContent?.replace(/\s+/g, ' ').trim() ?? '';
        if (text) return text;
      }
    }
    return '';
  }

  get profileUrl(): string {
    if (this.profileCard) {
      const links = Array.from(
        this.profileCard.querySelectorAll('a[href*="/in/"]'),
      ) as HTMLAnchorElement[];
      const preferred = links.find((a) => !a.querySelector('img')) ?? links[0] ?? null;
      if (preferred) return normalizeLinkedInUrl(preferred.href);
    }
    if (this.titleBarAnchor) return normalizeLinkedInUrl(this.titleBarAnchor.href);
    return '';
  }

  get container(): HTMLElement | null {
    return this.profileCard ?? this.titleBarAnchor;
  }
}
