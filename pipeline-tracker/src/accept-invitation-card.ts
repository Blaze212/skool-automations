/**
 * Encapsulates data extraction for a single invitation card on LinkedIn's
 * My Network / invitation-manager page.
 *
 * Card boundary: [role="listitem"] or <li> containing an Accept button.
 * Mirrors the class structure of ConnectionSearchCard / ProfilePageCard
 * from linkedin-tracker — self-contained, no imports from content.ts.
 */

// Matches straight apostrophe (U+0027), left curly (U+2018), right curly (U+2019)
const APOS = '[\\u0027\\u2018\\u2019]';
const ACCEPT_LABEL_PATTERNS = [
  new RegExp(`^accept\\s+(.+?)${APOS}s\\s+invitation`, 'i'),
  new RegExp(`^accept\\s+(.+?)${APOS}s\\s+request`, 'i'),
  new RegExp(`^accept\\s+(.+?)${APOS}s\\s+connection`, 'i'),
  /^accept\s+invitation\s+from\s+(.+)$/i,
  /^accept\s+request\s+from\s+(.+)$/i,
  /^accept\s+(.+?)(?:\s+(?:invitation|request|connection|to\s+connect).*)?$/i,
];

const TITLE_NOISE = /mutual connection|connection(s)?|follower(s)?|premium|open to work/i;

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

export class AcceptInvitationCard {
  constructor(
    private readonly card: HTMLElement,
    private readonly acceptButton: HTMLElement,
  ) {}

  /**
   * Builds an AcceptInvitationCard by walking up from the Accept button to find
   * the enclosing [role="listitem"] or <li>. Returns null if none found.
   */
  static fromAcceptButton(button: HTMLElement): AcceptInvitationCard | null {
    const card = button.closest('[role="listitem"], li') as HTMLElement | null;
    if (!card) return null;
    return new AcceptInvitationCard(card, button);
  }

  /**
   * Person's name — primary: aria-label patterns (straight + curly apostrophe).
   * Fallbacks: /in/ link text, then direct text in <strong>/<b>.
   */
  get name(): string {
    const label = this.acceptButton.getAttribute('aria-label') ?? '';
    for (const pattern of ACCEPT_LABEL_PATTERNS) {
      const m = label.match(pattern);
      if (m) return m[1].trim();
    }

    // Fallback: /in/ link text — skip avatar links (have <img>), name links don't
    const links = Array.from(this.card.querySelectorAll('a[href*="/in/"]')) as HTMLAnchorElement[];
    for (const link of links) {
      if (link.querySelector('img')) continue;
      const text = link.textContent?.trim() ?? '';
      if (text.length > 1) return text;
    }

    // Fallback: direct text nodes in <strong>/<b> — strips badge spans
    for (const el of Array.from(this.card.querySelectorAll('strong, b')) as HTMLElement[]) {
      const directText = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => (n.textContent ?? '').trim())
        .filter((t) => t.length > 0)
        .join(' ');
      if (directText.length > 1) return directText;
    }

    return '';
  }

  /**
   * Person's LinkedIn headline.
   * S1: name-<p> sibling walk — mirrors ConnectionSearchCard S1 without vanityName pinning.
   * S2: longest non-anchor <span> ≥ 15 chars.
   * S3: [title] attribute on non-anchor element.
   */
  get title(): string {
    // S1: find the <p> that contains the name link, walk its siblings
    const namePara = Array.from(this.card.querySelectorAll('p')).find((p) =>
      p.querySelector('a[href*="/in/"]'),
    ) as HTMLElement | undefined;
    if (namePara) {
      let sib = namePara.nextElementSibling as HTMLElement | null;
      while (sib) {
        if (!sib.querySelector('button, a[aria-label]')) {
          const t = sib.textContent?.trim() ?? '';
          if (t.length >= 5 && !/^\d/.test(t) && !TITLE_NOISE.test(t)) return t;
        }
        sib = sib.nextElementSibling as HTMLElement | null;
      }
    }

    // S2: longest non-anchor span
    const spans = (Array.from(this.card.querySelectorAll('span')) as HTMLElement[])
      .filter((s) => {
        if (s.closest('a')) return false;
        const t = s.textContent?.trim() ?? '';
        return t.length >= 15 && !/^\d/.test(t) && !TITLE_NOISE.test(t);
      })
      .sort((a, b) => (b.textContent?.trim() ?? '').length - (a.textContent?.trim() ?? '').length);
    if (spans[0]) return spans[0].textContent!.trim();

    // S3: [title] attribute
    for (const el of Array.from(this.card.querySelectorAll('[title]')) as HTMLElement[]) {
      if (el.closest('a')) continue;
      const t = el.getAttribute('title') ?? '';
      if (t.length >= 15 && !/^\d/.test(t) && !TITLE_NOISE.test(t)) return t;
    }

    return '';
  }

  /** Normalized canonical profile URL from the first non-avatar /in/ link. */
  get profileUrl(): string {
    const anchors = Array.from(
      this.card.querySelectorAll('a[href*="/in/"]'),
    ) as HTMLAnchorElement[];
    const preferred = anchors.find((a) => !a.querySelector('img')) ?? anchors[0] ?? null;
    return normalizeLinkedInUrl(preferred?.href ?? '');
  }

  /** The card element — used by the handler for debug payload construction. */
  get container(): HTMLElement {
    return this.card;
  }

  /** Invitation note text, if any was included. */
  get messageText(): string {
    return (
      this.card.querySelector('[data-testid="expandable-text-box"]')?.textContent?.trim() ?? ''
    );
  }
}
