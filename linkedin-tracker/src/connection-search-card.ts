/**
 * Encapsulates data extraction for a single person card on LinkedIn's
 * /search/results/people/ page (the connection search page).
 *
 * Scoping extraction here makes it obvious which page structure changed
 * when title or URL extraction breaks.
 *
 * All selectors intentionally avoid class names — LinkedIn hashes them
 * and changes them frequently. We anchor on structural attributes only:
 * role=listitem, href patterns, and stable text prefixes.
 */
export class ConnectionSearchCard {
  /** URL path pattern for LinkedIn people / connection search. */
  static readonly PAGE_PATH_PATTERN = /\/search\/results\/people\//;

  constructor(
    private readonly card: HTMLElement,
    private readonly connectLink: HTMLElement,
  ) {}

  /**
   * Builds a ConnectionSearchCard by walking up the DOM from the
   * "Invite X to connect" link to find the enclosing card element.
   * Returns null if no card boundary is found.
   */
  static fromConnectLink(connectLink: HTMLElement): ConnectionSearchCard | null {
    const card = connectLink.closest(
      'li, [data-view-name], [role="listitem"]',
    ) as HTMLElement | null;
    if (!card) return null;
    return new ConnectionSearchCard(card, connectLink);
  }

  /**
   * Extracts the person's headline/title using two strategies:
   *   1. Structural: name <p> → first non-action sibling element.
   *   2. Fallback: "Current: ..." snippet LinkedIn appends to some cards.
   */
  get title(): string {
    const m = (this.connectLink.getAttribute('href') ?? '').match(/vanityName=([^&]+)/);
    if (!m) return '';
    const vanityName = m[1];

    // Strategy 1: name link is inside a <p>; walk that <p>'s siblings for the title div.
    // "p a[href*=...]" skips the outer card-wrapper <a> which is not inside a <p>.
    const nameLink = this.card.querySelector(
      `p a[href*="/in/${vanityName}"]`,
    ) as HTMLElement | null;
    const namePara = nameLink?.closest('p') as HTMLElement | null;
    if (namePara) {
      let el = namePara.nextElementSibling as HTMLElement | null;
      while (el) {
        if (!el.querySelector('button, a[aria-label]')) {
          const text = el.textContent?.trim() ?? '';
          if (text.length >= 5) return text;
        }
        el = el.nextElementSibling as HTMLElement | null;
      }
    }

    // Strategy 2: "Current: <title>" snippet LinkedIn injects below some cards.
    for (const span of Array.from(this.card.querySelectorAll('span'))) {
      const text = span.textContent?.trim() ?? '';
      if (text.startsWith('Current: ') && text.length > 9) {
        return text.replace(/^Current:\s*/, '');
      }
    }

    return '';
  }

  /**
   * Extracts the canonical LinkedIn profile URL.
   * Prefers vanityName from the connect button href; falls back to the
   * card wrapper <a> link.
   */
  get profileUrl(): string {
    const m = (this.connectLink.getAttribute('href') ?? '').match(/vanityName=([^&]+)/);
    if (m) return `https://www.linkedin.com/in/${m[1]}/`;

    const cardLink = this.card.querySelector(
      'a[href*="linkedin.com/in/"]',
    ) as HTMLAnchorElement | null;
    if (cardLink?.href) return cardLink.href.split('?')[0].replace(/\/?$/, '/');

    return '';
  }
}
