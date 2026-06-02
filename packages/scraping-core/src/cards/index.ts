/**
 * Card classes encapsulate per-context DOM extraction for one LinkedIn surface
 * (My Network invitation tile, profile page Accept header, chat overlay,
 * full messenger page). Each card exposes the same shape (`name`, `title`,
 * `profileUrl`, optional `messageText`, `container`) so the orchestrator in
 * `extract.ts` can treat them uniformly.
 *
 * The `Card.from(target)` router added in Phase 4 will dispatch to the right
 * card; for now this module just re-exports the classes and a `CardClass`
 * union type so consumers can import everything from one place.
 */

export { AcceptInvitationCard } from './accept-invitation-card.js';
export { ChatOverlayCard } from './chat-overlay-card.js';
export { MessengerPageCard } from './messenger-page-card.js';
export { ProfilePageAcceptCard } from './profile-page-accept-card.js';
export { SalesNavLeadCard } from './sales-nav-lead-card.js';
export { SalesNavMenuCard } from './sales-nav-menu-card.js';
export { SalesNavConnectModalCard } from './sales-nav-connect-modal-card.js';

import { AcceptInvitationCard } from './accept-invitation-card.js';
import { ChatOverlayCard } from './chat-overlay-card.js';
import { MessengerPageCard } from './messenger-page-card.js';
import { ProfilePageAcceptCard } from './profile-page-accept-card.js';
import { SalesNavLeadCard } from './sales-nav-lead-card.js';
import { SalesNavMenuCard } from './sales-nav-menu-card.js';
import { SalesNavConnectModalCard } from './sales-nav-connect-modal-card.js';

/**
 * Union of every card class. Phase 4's orchestrator narrows this when picking
 * the right card for a given target; for now it exists so downstream code can
 * type a "some card" reference without listing them inline.
 */
export type CardClass =
  | typeof AcceptInvitationCard
  | typeof ChatOverlayCard
  | typeof MessengerPageCard
  | typeof ProfilePageAcceptCard
  | typeof SalesNavLeadCard
  | typeof SalesNavMenuCard
  | typeof SalesNavConnectModalCard;

/**
 * Stable `Card` namespace handle. Phase 4 attaches the `from(target)` router
 * here; today it just groups the classes so consumers can write
 * `import { Card } from '@cs/scraping-core'` and reach every card type.
 */
export const Card = {
  AcceptInvitationCard,
  ChatOverlayCard,
  MessengerPageCard,
  ProfilePageAcceptCard,
  SalesNavLeadCard,
  SalesNavMenuCard,
  SalesNavConnectModalCard,
} as const;
