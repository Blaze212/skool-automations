/**
 * Encapsulates the Sales Navigator actions dropdown — the popover menu that
 * opens from a search-result row's "…" button or a profile preview/hovercard.
 * It contains menu items such as Connect, View profile, Add note, View LinkedIn
 * profile, and Copy LinkedIn.com URL.
 *
 * The menu is rendered detached at the document root (a `hue-menu-*` popover
 * positioned with a transform), so it is NOT a DOM ancestor of the row or
 * profile that spawned it. It also carries no name or headline — only links.
 * Its value to the pipeline tracker is the profile URL: the "View profile" item
 * links to `/sales/lead/{leadId}` and, on the preview menu, "View LinkedIn
 * profile" exposes the canonical public `/in/{vanity}` URL.
 *
 * We anchor on the link hrefs (and the stable `data-control-name=
 * "view_profile_via_result_menu"` attribute) rather than the hashed
 * `_item_xxxx` classes. Name/title are intentionally empty — the caller pairs
 * this card's URL with the name captured from the Send-invitation modal.
 */

import { normalizeSalesLeadUrl, resolveProfileUrl } from './sales-nav-url.js';

export class SalesNavMenuCard {
  constructor(private readonly menu: HTMLElement) {}

  /**
   * Build a card from any item inside the menu. Walks up to the enclosing `<ul>`
   * (every item is an `<li>`), falling back to the menu popover container.
   * Returns null when the menu carries no lead/profile link — i.e. it isn't a
   * Sales Nav person menu (guards against unrelated dropdowns elsewhere on the
   * page).
   */
  static fromMenuItem(item: HTMLElement): SalesNavMenuCard | null {
    const menu = (item.closest('ul') ??
      item.closest('[role="menu"]') ??
      item.parentElement) as HTMLElement | null;
    if (!menu) return null;
    const hasProfileLink =
      menu.querySelector('a[href*="/sales/lead/"]') ?? menu.querySelector('a[href*="/in/"]');
    return hasProfileLink ? new SalesNavMenuCard(menu) : null;
  }

  /** Best profile URL — public `/in/{vanity}` if present, else the lead URL. */
  get profileUrl(): string {
    return resolveProfileUrl(this.menu);
  }

  /** Sales-Nav-native lead identifier, normalized. */
  get leadUrl(): string {
    const link = this.menu.querySelector('a[href*="/sales/lead/"]') as HTMLAnchorElement | null;
    return link ? normalizeSalesLeadUrl(link.getAttribute('href') ?? link.href) : '';
  }

  /** The menu carries no name. */
  get name(): string {
    return '';
  }

  /** The menu carries no headline. */
  get title(): string {
    return '';
  }

  /** The menu element — used by the handler for debug payload construction. */
  get container(): HTMLElement {
    return this.menu;
  }

  /** The menu carries no invitation note. */
  get messageText(): string {
    return '';
  }
}
