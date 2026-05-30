/**
 * Orchestrator: route a DOM target to the right Card, extract the fields,
 * build a PipelineEvent, run validate(), and return everything in one
 * ExtractResult.
 *
 * Scope (spec 011 phase 4):
 *   - Implemented for accept-connection flows (My Network AcceptInvitationCard
 *     + profile-page ProfilePageAcceptCard).
 *   - Direct-message and connection-request flows still route through
 *     content.ts's flow-specific handlers because their target-discovery
 *     logic isn't a single Card.from(target) lookup (DM uses Strategy 0-3
 *     fallback; connection_request stages data across two separate clicks).
 *     Folding those into extract() is tracked as a follow-up in TODOS.md.
 *
 * Spec 013 will:
 *   - Set `source: 'ai-recovered'` when on-device LLM repair fills a gap
 *     reported by validate().
 *   - Use the `aiOptions` parameter declared here as the call site.
 */

import { AcceptInvitationCard, ProfilePageAcceptCard } from './cards/index.js';
import { validate, type ValidationResult } from './validate.js';
import type { EventType, ExtractionSource, PipelineEvent } from './types.js';

/**
 * Discriminates the orchestrator's calling context so future card types can
 * slot in without adding new optional fields to the input.
 */
export type ExtractEventHint = 'accepted_connection';

export interface ExtractInput {
  /** The host document. Passed in (not read from globalThis) so the
   * orchestrator stays portable across iframes, jsdom test environments,
   * and the future side-panel build. */
  document: Document;
  /** The element the user clicked / interacted with — the seed for the
   * card router. */
  target: HTMLElement;
  /** Full URL of the page. Cards that anchor on the URL (e.g.
   * ProfilePageAcceptCard's vanity match) read it from here rather than
   * `window.location`. */
  pageUrl: string;
  /** Hints which flow is calling. extract() can usually infer from the
   * target alone; the hint disambiguates when more than one card would
   * match. */
  eventType: ExtractEventHint;
  /** Reserved for spec 013 — on-device AI fallback options.
   * Unused today; declared so spec 013's diff is minimal. */
  aiOptions?: AiRecoveryOptions;
}

/**
 * Placeholder for spec 013. Today extract() ignores this parameter; the shape
 * lives here so spec 013's PR only adds AI client wiring, not API surface.
 */
export interface AiRecoveryOptions {
  /** When true, retry validation gaps via on-device LanguageModel. */
  enabled?: boolean;
  /** Abort the recovery attempt after this many ms (Chrome Prompt API
   * recommends always wrapping in an AbortSignal — see chrome-extension-mv3
   * skill). */
  timeoutMs?: number;
}

export interface ExtractResult {
  /** Fully populated event — fields filled to best ability. Caller is
   * responsible for setting `api_key` (which the cards don't know). */
  event: PipelineEvent;
  /** Which extraction path produced the values. */
  source: ExtractionSource;
  /** Output of validate(event). `dirty: true` means at least one gap. */
  validation: ValidationResult;
}

// =============================================================================
// Internal helpers
// =============================================================================

interface CardFields {
  name: string;
  title: string;
  profileUrl: string;
  messageText: string;
}

/**
 * Route an accept-button target to the right card. Tries the My Network
 * AcceptInvitationCard first (button is inside [role="listitem"]) then falls
 * back to ProfilePageAcceptCard (button sits in the profile header). Both
 * cards' fromAcceptButton constructors return null when their structural
 * conditions don't match, so the chain is safe.
 */
function findAcceptCard(target: HTMLElement, pageUrl: string): CardFields | null {
  const invitation = AcceptInvitationCard.fromAcceptButton(target);
  if (invitation) {
    return {
      name: invitation.name,
      title: invitation.title,
      profileUrl: invitation.profileUrl,
      messageText: invitation.messageText,
    };
  }
  // ProfilePageAcceptCard reads vanity from window.location internally today;
  // tests already monkey-patch window.history.pushState to set the path, so
  // we don't need to plumb pageUrl through here. Keeping pageUrl in the
  // signature preserves the future ability to inject location for SSR or
  // side-panel contexts (spec 012).
  void pageUrl;
  const profile = ProfilePageAcceptCard.fromAcceptButton(target);
  if (profile) {
    return {
      name: profile.name,
      title: profile.title,
      profileUrl: profile.profileUrl,
      messageText: profile.messageText,
    };
  }
  return null;
}

function buildEvent(
  eventType: EventType,
  fields: CardFields | null,
  pageUrl: string,
): PipelineEvent {
  return {
    api_key: '', // caller fills from chrome.storage.sync
    event_type: eventType,
    date: new Date().toISOString().slice(0, 10),
    name: fields?.name ?? '',
    title: fields?.title ?? '',
    linkedin_url: fields?.profileUrl ?? '',
    page_url: pageUrl,
    message_text: fields?.messageText ?? '',
  };
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Orchestrator entry. Returns an ExtractResult even when no card matches —
 * the event will have empty name/title/url and validate() will flag the
 * required-field gaps, so the caller decides whether to send or drop.
 */
export function extract(input: ExtractInput): ExtractResult {
  if (input.eventType !== 'accepted_connection') {
    // Phase 4 only covers accept-connection. See file header for the
    // rationale; DM + connection_request flows continue to call cards
    // directly from content.ts until follow-up consolidation.
    throw new Error(
      `extract() does not yet support eventType="${input.eventType}" — phase 4 covers 'accepted_connection' only`,
    );
  }

  const fields = findAcceptCard(input.target, input.pageUrl);
  const event = buildEvent('accepted_connection', fields, input.pageUrl);
  const validation = validate(event);
  return { event, source: 'selectors', validation };
}
