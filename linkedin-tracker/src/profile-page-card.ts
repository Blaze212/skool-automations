/**
 * Encapsulates data extraction for a person card on LinkedIn profile pages
 * (e.g., "People you may know" / "People also viewed" sidebar cards).
 *
 * Profile page connect links use /preload/custom-invite/ whereas search pages
 * use /preload/search-custom-invite/. Cards here have no [role="listitem"] ancestor
 * so ConnectionSearchCard cannot find them.
 *
 * The card boundary is located by walking up from the connect link until an ancestor
 * contains the heading link (a[href*="/in/vanityName/"] h2) for this specific person.
 */
export class ProfilePageCard {
  /** URL path pattern for LinkedIn individual profile pages. */
  static readonly PAGE_PATH_PATTERN = /\/in\/[^/]+/;

  constructor(
    private readonly connectLink: HTMLElement,
    private readonly card: HTMLElement,
  ) {}

  /**
   * Builds a ProfilePageCard by walking up the DOM from the connect link until an
   * ancestor containing this person's heading link is found.
   * Returns null if the href is not a profile-page invite or no card boundary exists.
   */
  static fromConnectLink(connectLink: HTMLElement): ProfilePageCard | null {
    const href = connectLink.getAttribute('href') ?? '';
    if (!href.match(/\/preload\/custom-invite\//) || !href.includes('vanityName=')) return null;
    const m = href.match(/vanityName=([^&]+)/);
    if (!m) return null;
    const vanityName = m[1];

    let card: HTMLElement | null = connectLink.parentElement;
    while (card) {
      if (card.querySelector(`a[href*="/in/${vanityName}/"] h2`)) break;
      card = card.parentElement;
    }
    if (!card) return null;

    return new ProfilePageCard(connectLink, card);
  }

  private get vanityName(): string {
    const m = (this.connectLink.getAttribute('href') ?? '').match(/vanityName=([^&]+)/);
    return m ? m[1] : '';
  }

  /** Returns the canonical LinkedIn profile URL from the vanityName in the connect href. */
  get profileUrl(): string {
    const vn = this.vanityName;
    return vn ? `https://www.linkedin.com/in/${vn}/` : '';
  }

  /**
   * Extracts the person's headline by locating the <h2> in the card, then walking up
   * through ancestors looking for a sibling <p> that is the title (not a degree marker
   * like "· 1st" or a numeric count like "500+ connections").
   */
  get title(): string {
    const vn = this.vanityName;
    if (!vn) return '';

    const heading = this.card.querySelector(`a[href*="/in/${vn}/"] h2`) as HTMLElement | null;
    if (!heading) return '';

    let el: HTMLElement | null = heading.parentElement;
    while (el && el !== this.card) {
      let sibling = el.nextElementSibling as HTMLElement | null;
      while (sibling) {
        if (sibling.tagName === 'P') {
          const text = sibling.textContent?.trim() ?? '';
          if (text.length >= 5 && !text.startsWith('·') && !text.match(/^\d/)) return text;
        }
        sibling = sibling.nextElementSibling as HTMLElement | null;
      }
      el = el.parentElement;
    }

    return '';
  }
}
