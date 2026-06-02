/**
 * Encapsulates the Sales Navigator "Send invitation" confirmation modal —
 * `div[role="dialog"]` titled by `#connect-cta-form__header` and tagged
 * `data-sn-view-name="subpage-connect-modal"`. This is the moment a connection
 * request is actually sent: the user clicks Connect (in a row menu, preview, or
 * the profile header), this modal opens pre-populated with the recipient, they
 * optionally type a note, then click "Send Invitation".
 *
 * The modal is the authoritative source for two fields the trigger surfaces
 * can't always provide:
 *   - `name`  — `[data-anonymize="person-name"]` inside the entity lockup.
 *   - `messageText` — the optional personal note in
 *     `textarea#connect-cta-form__invitation`.
 *
 * It does NOT contain the headline or a profile URL, so the caller merges those
 * from the data staged on the original Connect click (see content.ts). We anchor
 * on the stable `data-anonymize`, `data-sn-view-name`, and `id` hooks rather than
 * the hashed Ember classes.
 */

export class SalesNavConnectModalCard {
  constructor(private readonly modal: HTMLElement) {}

  /** True when `modal` is the Sales Nav connect modal (not some other dialog). */
  private static isConnectModal(modal: HTMLElement | null): modal is HTMLElement {
    if (!modal) return false;
    return !!(
      modal.querySelector('#connect-cta-form__header') ??
      modal.querySelector('[data-sn-view-name="subpage-connect-modal"]') ??
      modal.querySelector('#connect-cta-form__invitation')
    );
  }

  /** Build a card by walking up from the "Send Invitation" button to its dialog. */
  static fromSendButton(button: HTMLElement): SalesNavConnectModalCard | null {
    const modal = button.closest('[role="dialog"]') as HTMLElement | null;
    return SalesNavConnectModalCard.isConnectModal(modal)
      ? new SalesNavConnectModalCard(modal)
      : null;
  }

  /** Build a card by locating the connect modal anywhere in the document. */
  static fromDocument(doc: Document = document): SalesNavConnectModalCard | null {
    const dialogs = Array.from(doc.querySelectorAll('[role="dialog"]')) as HTMLElement[];
    const modal = dialogs.find((d) => SalesNavConnectModalCard.isConnectModal(d)) ?? null;
    return modal ? new SalesNavConnectModalCard(modal) : null;
  }

  /** Recipient name from the lockup; the degree badge sits in a sibling span. */
  get name(): string {
    const nameEl = this.modal.querySelector('[data-anonymize="person-name"]') as HTMLElement | null;
    return nameEl?.textContent?.trim() ?? '';
  }

  /** The optional personal note typed into the invitation textarea. */
  get messageText(): string {
    const textarea = this.modal.querySelector(
      '#connect-cta-form__invitation',
    ) as HTMLTextAreaElement | null;
    return textarea?.value?.trim() ?? '';
  }

  /** The modal carries no headline. */
  get title(): string {
    return '';
  }

  /** The modal carries no profile URL. */
  get profileUrl(): string {
    return '';
  }

  /** The dialog element — used by the handler for debug payload construction. */
  get container(): HTMLElement {
    return this.modal;
  }
}
