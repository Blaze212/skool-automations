/**
 * Encapsulates data extraction for the lead profile header on a Sales Navigator
 * lead page (`/sales/lead/{leadId},...`). This is the `section._header_sqh8tm`
 * card that carries the person's name, headline, location, current company, and
 * the Save / Message / overflow action bar.
 *
 * Unlike regular LinkedIn (hashed, frequently-rotated class names), Sales Nav
 * annotates its profile fields with stable `data-anonymize` hooks
 * (`person-name`, `headline`, `job-title`, `company-logo`) and a
 * `data-x--lead--name` marker on the name heading. We anchor exclusively on
 * those — never on the Ember `_xxx_hash` classes — so the card survives the
 * weekly CSS churn.
 *
 * Mirrors the class shape of the regular-LinkedIn cards (`name` / `title` /
 * `profileUrl` / `container`) so content.ts can treat it uniformly. It adds a
 * `company` getter because Sales Nav surfaces it explicitly, and a `leadUrl`
 * helper for the Sales-Nav-native identifier.
 */

import { normalizeSalesLeadUrl, resolveProfileUrl } from './sales-nav-url.js';

export class SalesNavLeadCard {
  /** URL path pattern for a Sales Navigator lead page. */
  static readonly PAGE_PATH_PATTERN = /^\/sales\/lead\//;

  constructor(private readonly card: HTMLElement) {}

  /**
   * Walk up from `el` to the nearest ancestor that is the lead header — the
   * smallest element containing BOTH the `data-anonymize="person-name"` field
   * and the `data-anonymize="headline"` field. Returns null when no such
   * ancestor exists. Shared by both factories.
   */
  private static findHeader(el: HTMLElement | null): HTMLElement | null {
    let node: HTMLElement | null = el;
    while (node) {
      if (
        node.querySelector('[data-anonymize="person-name"]') &&
        node.querySelector('[data-anonymize="headline"]')
      ) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  /**
   * Build a card from an action-bar button (Save / Message / Connect / overflow).
   * The button lives inside `section[data-x--lead--profile-card-actions]`, which
   * is itself nested in the header section — so `button.closest('section')` only
   * reaches the actions bar; we walk further up to the header proper.
   */
  static fromActionButton(button: HTMLElement): SalesNavLeadCard | null {
    const header = SalesNavLeadCard.findHeader(button);
    return header ? new SalesNavLeadCard(header) : null;
  }

  /**
   * Build a card from the document — used when staging on a "Connect" click that
   * fires inside a detached popover menu (the menu isn't a DOM ancestor of the
   * header, so fromActionButton can't reach it). On a lead page there is exactly
   * one header; we locate it via the person-name field and walk up to the header
   * boundary.
   */
  static fromDocument(doc: Document = document): SalesNavLeadCard | null {
    const nameEl = doc.querySelector('[data-anonymize="person-name"]') as HTMLElement | null;
    const header = SalesNavLeadCard.findHeader(nameEl);
    return header ? new SalesNavLeadCard(header) : null;
  }

  /**
   * Lead's name. Prefer the inner `a[data-anonymize="person-name"]` (its text is
   * just the name) over the wrapping `h1[data-x--lead--name]` (same text, but the
   * anchor is the tighter scope). The pronoun/degree sublabel lives in a sibling
   * span, so neither source picks it up.
   */
  get name(): string {
    const link = this.card.querySelector('a[data-anonymize="person-name"]') as HTMLElement | null;
    if (link?.textContent?.trim()) return link.textContent.trim();

    const heading = (this.card.querySelector('[data-x--lead--name]') ??
      this.card.querySelector('[data-anonymize="person-name"]')) as HTMLElement | null;
    return heading?.textContent?.trim() ?? '';
  }

  /** Lead's headline (e.g. "Founder & Managing Director at Web3 Recruit"). */
  get title(): string {
    const headline = this.card.querySelector('[data-anonymize="headline"]') as HTMLElement | null;
    return headline?.textContent?.trim() ?? '';
  }

  /**
   * Current company name. Sales Nav puts it on the company-logo `img[title]`
   * (and `alt`) next to the experience block. Returns '' when absent.
   */
  get company(): string {
    const logo = this.card.querySelector(
      'a[href*="/sales/company/"] img',
    ) as HTMLImageElement | null;
    const fromTitle = logo?.getAttribute('title')?.trim();
    if (fromTitle) return fromTitle;
    const fromAlt = logo?.getAttribute('alt')?.trim();
    return fromAlt && fromAlt.length > 1 ? fromAlt : '';
  }

  /**
   * Best profile URL: a public `/in/{vanity}` link if one is present, else the
   * normalized Sales Nav lead URL. The header itself only links to `/sales/lead/`,
   * so in practice this returns the lead URL — content.ts upgrades it to the
   * public URL when a preview menu (which exposes "View LinkedIn profile") was
   * the trigger.
   */
  get profileUrl(): string {
    return resolveProfileUrl(this.card);
  }

  /** Sales-Nav-native lead identifier, normalized to drop the search-context suffix. */
  get leadUrl(): string {
    const link = this.card.querySelector('a[href*="/sales/lead/"]') as HTMLAnchorElement | null;
    return link ? normalizeSalesLeadUrl(link.getAttribute('href') ?? link.href) : '';
  }

  /** The header element — used by the handler for debug payload construction. */
  get container(): HTMLElement {
    return this.card;
  }

  /** No invitation note is shown in the lead header itself. */
  get messageText(): string {
    return '';
  }
}
