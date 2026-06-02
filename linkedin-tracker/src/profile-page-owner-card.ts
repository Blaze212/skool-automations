/**
 * Encapsulates "profile owner" data extraction on a LinkedIn profile page
 * (URL of the form /in/{vanity}/).
 *
 * Use this when no card-bearing element (Connect link, Accept button) is
 * available — e.g., the Connect button was missed at click time due to
 * LinkedIn's display:contents wrappers, and the only thing we have left to
 * work with by the time the user clicks Send in the invite modal is the
 * current URL. Falling back to scraping the modal in that case yields the
 * modal's UI title ("Add a note to your invitation") which is wrong; this
 * class reads the profile page itself instead.
 *
 * Mirrors ProfilePageAcceptCard's URL-anchored fallback path: locate the
 * profile owner's heading anchor (a[href*="/in/{vanity}/"] h2) anywhere in
 * the document, then walk siblings for the headline <p>.
 */

const PRONOUN_RE = /^[A-Za-z]+\/[A-Za-z]+(\/[A-Za-z]+)?$/;
const TITLE_NOISE =
  /mutual connection|connection(s)?|follower(s)?|premium|open to work|contact info/i;

export class ProfilePageOwnerCard {
  /** URL path pattern for LinkedIn individual profile pages. */
  static readonly PAGE_PATH_PATTERN = /^\/in\/([^/]+)/;

  constructor(
    private readonly card: HTMLElement,
    private readonly vanity: string,
  ) {}

  /**
   * Build a ProfilePageOwnerCard for whoever owns the current profile page.
   * Returns null when:
   *   - the URL is not /in/{vanity}/
   *   - no a[href*="/in/{vanity}/"] h2 exists anywhere in the document
   */
  static fromCurrentUrl(): ProfilePageOwnerCard | null {
    const m = window.location.pathname.match(ProfilePageOwnerCard.PAGE_PATH_PATTERN);
    if (!m) return null;
    const vanity = m[1];

    const headingAnchor = document
      .querySelector(`a[href*="/in/${vanity}/"] h2`)
      ?.closest('a') as HTMLElement | null;
    if (!headingAnchor) return null;

    const card = (headingAnchor.closest('section, main, [role="main"]') ??
      document.body) as HTMLElement;
    return new ProfilePageOwnerCard(card, vanity);
  }

  /** Profile owner's name — text of the <h2> inside the heading anchor. */
  get name(): string {
    const heading = this.card.querySelector(
      `a[href*="/in/${this.vanity}/"] h2`,
    ) as HTMLElement | null;
    return heading?.textContent?.trim() ?? '';
  }

  /** Canonical profile URL derived from the vanity name in the page URL. */
  get profileUrl(): string {
    return `https://www.linkedin.com/in/${this.vanity}`;
  }

  /** The resolved card scope (profile top-card section) — used as the HTML
   * context for the spec 013 on-device AI fallback. */
  get container(): HTMLElement {
    return this.card;
  }

  /**
   * Profile headline — same sibling-walk logic as ProfilePageAcceptCard.
   * Skips degree markers, pronouns, connection counts and other noise; returns
   * the longest survivor from the nearest level that yielded any candidate.
   */
  get title(): string {
    const heading = this.card.querySelector(
      `a[href*="/in/${this.vanity}/"] h2`,
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
      const before = candidates.length;
      let sib = el.nextElementSibling as HTMLElement | null;
      while (sib) {
        if (sib.tagName === 'P') consider(sib);
        for (const p of Array.from(sib.querySelectorAll('p')) as HTMLElement[]) consider(p);
        sib = sib.nextElementSibling as HTMLElement | null;
      }
      if (candidates.length > before) break;
      el = el.parentElement;
    }

    return candidates.sort((a, b) => b.length - a.length)[0] ?? '';
  }
}
