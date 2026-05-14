/**
 * Extracts profile data from the full LinkedIn messenger page (/messaging/).
 *
 * On full messenger threads the recipient's profile card (.msg-s-profile-card)
 * sits at the top of the message list, outside the compose form's ancestor chain,
 * so the generic DOM-walking strategy in extractMessagingRecipient cannot reach it.
 *
 * Name and URL use the same structural rule as the primary walking strategy:
 * find an /in/ anchor that does NOT wrap an img (the avatar link wraps an img).
 * This avoids relying on hashed/unstable class names like profile-card-one-to-one__profile-link.
 */
export class MessengerPageCard {
  private constructor(private readonly card: HTMLElement) {}

  static fromDocument(): MessengerPageCard | null {
    const card = document.querySelector('.msg-s-profile-card') as HTMLElement | null;
    if (!card) return null;
    return new MessengerPageCard(card);
  }

  private get nameLink(): HTMLAnchorElement | null {
    const links = Array.from(this.card.querySelectorAll('a[href*="/in/"]')) as HTMLAnchorElement[];
    return links.find((a) => !a.querySelector('img')) ?? null;
  }

  get name(): string {
    return this.nameLink?.textContent?.trim() ?? '';
  }

  get profileUrl(): string {
    return this.nameLink?.href ?? '';
  }

  get title(): string {
    // Prefer the title attribute — already formatted, no whitespace from nested elements.
    const div = this.card.querySelector(
      '.artdeco-entity-lockup__subtitle div[title]',
    ) as HTMLElement | null;
    if (div) {
      const t = div.getAttribute('title') ?? '';
      if (t.length >= 5) return t;
    }
    const subtitleEl = this.card.querySelector(
      '.artdeco-entity-lockup__subtitle',
    ) as HTMLElement | null;
    return subtitleEl?.textContent?.trim() ?? '';
  }
}
