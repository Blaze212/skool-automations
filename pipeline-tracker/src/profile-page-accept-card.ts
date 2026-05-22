/**
 * Encapsulates data extraction for an "Accept" connection-request button that
 * appears in the profile page header (where the "Connect" button normally sits
 * when there is no pending incoming request).
 *
 * Differs from AcceptInvitationCard (My Network invitation-manager page) in two
 * key ways:
 *   1. No [role="listitem"] or <li> ancestor — the card boundary is the profile
 *      header section.
 *   2. The page URL itself is /in/{vanity}/, so vanityName is read from the URL
 *      rather than scraped from a connect link.
 *
 * Mirrors ProfilePageCard's vanity-anchored walk: find the smallest ancestor of
 * the Accept button that also contains the heading link
 * (a[href*="/in/{vanity}/"] h2) for the profile owner.
 */

// Pronouns commonly displayed next to the profile name (e.g. "She/Her", "They/Them").
const PRONOUN_RE = /^[A-Za-z]+\/[A-Za-z]+(\/[A-Za-z]+)?$/;
const TITLE_NOISE =
  /mutual connection|connection(s)?|follower(s)?|premium|open to work|contact info/i;

export class ProfilePageAcceptCard {
  /** URL path pattern for LinkedIn individual profile pages. */
  static readonly PAGE_PATH_PATTERN = /^\/in\/([^/]+)/;

  constructor(
    private readonly card: HTMLElement,
    private readonly acceptButton: HTMLElement,
    private readonly vanityName: string,
  ) {}

  /**
   * Builds a ProfilePageAcceptCard by reading the vanity name from the current
   * URL, then walking up from the Accept button until an ancestor containing
   * the profile owner's heading link is found.
   *
   * Returns null when:
   *   - the current page is not /in/{vanity}/
   *   - no ancestor of the button contains a[href*="/in/{vanity}/"] h2
   */
  static fromAcceptButton(button: HTMLElement): ProfilePageAcceptCard | null {
    const m = window.location.pathname.match(ProfilePageAcceptCard.PAGE_PATH_PATTERN);
    if (!m) return null;
    const vanityName = m[1];

    let card: HTMLElement | null = button.parentElement;
    while (card) {
      if (card.querySelector(`a[href*="/in/${vanityName}/"] h2`)) {
        return new ProfilePageAcceptCard(card, button, vanityName);
      }
      card = card.parentElement;
    }
    return null;
  }

  /** Profile owner's name — text of the <h2> inside the heading anchor. */
  get name(): string {
    const heading = this.card.querySelector(
      `a[href*="/in/${this.vanityName}/"] h2`,
    ) as HTMLElement | null;
    return heading?.textContent?.trim() ?? '';
  }

  /** Canonical profile URL derived from the vanity name in the page URL. */
  get profileUrl(): string {
    return `https://www.linkedin.com/in/${this.vanityName}`;
  }

  /**
   * Profile headline — the long <p> sibling near the name block.
   *
   * Walks up from the heading and scans every sibling for <p> candidates
   * (direct or nested). Filters out pronouns ("She/Her"), degree markers
   * ("· 1st"), connection counts ("500+"), location/contact noise, and any
   * <p> that contains an action element. Returns the longest survivor since
   * LinkedIn headlines are typically far longer than nearby metadata.
   */
  get title(): string {
    const heading = this.card.querySelector(
      `a[href*="/in/${this.vanityName}/"] h2`,
    ) as HTMLElement | null;
    if (!heading) return '';

    const candidates: string[] = [];
    const consider = (p: HTMLElement) => {
      if (p.querySelector('button, a[aria-label]')) return;
      const t = p.textContent?.trim() ?? '';
      if (t.length < 5) return;
      if (t.startsWith('·')) return;
      if (/^\d/.test(t)) return;
      if (PRONOUN_RE.test(t)) return;
      if (TITLE_NOISE.test(t)) return;
      candidates.push(t);
    };

    let el: HTMLElement | null = heading.parentElement;
    while (el && el !== this.card) {
      let sib = el.nextElementSibling as HTMLElement | null;
      while (sib) {
        if (sib.tagName === 'P') consider(sib);
        for (const p of Array.from(sib.querySelectorAll('p')) as HTMLElement[]) consider(p);
        sib = sib.nextElementSibling as HTMLElement | null;
      }
      el = el.parentElement;
    }

    return candidates.sort((a, b) => b.length - a.length)[0] ?? '';
  }

  /** The card element — used by the handler for debug payload construction. */
  get container(): HTMLElement {
    return this.card;
  }

  /** No invitation note is shown on the profile-page Accept flow. */
  get messageText(): string {
    return '';
  }
}
