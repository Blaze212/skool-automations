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
 * Spec 013 (wired below):
 *   - When validate() flags a dirty result AND aiOptions.enabled AND the
 *     on-device model is available, run recover() to repair the gaps.
 *   - Set `source: 'ai-recovered'` and attach `recoveredHtml` when repair runs.
 */

import { AcceptInvitationCard, ProfilePageAcceptCard } from './cards/index.js';
import { validate, type ValidationResult } from './validate.js';
import type { EventType, ExtractionSource, PipelineEvent } from './types.js';
import { getCachedAvailability } from './ai-fallback/availability.js';
import { recover } from './ai-fallback/recover.js';
import { stripHtmlForCarry } from './ai-fallback/strip-html.js';

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
 * Spec 013 — on-device AI fallback options, passed from the caller's settings.
 */
export interface AiRecoveryOptions {
  /** When true, retry validation gaps via on-device LanguageModel.
   * Mirrors settings.ai_fallback_enabled. */
  enabled?: boolean;
  /** Reserved. recover() wraps each model call in fixed AbortSignal timeouts
   * (Chrome Prompt API best practice — see chrome-extension-mv3 skill). */
  timeoutMs?: number;
}

export interface ExtractResult {
  /** Fully populated event — fields filled to best ability. Caller is
   * responsible for setting `api_key` (which the cards don't know). */
  event: PipelineEvent;
  /** Which extraction path produced the values. */
  source: ExtractionSource;
  /** Output of validate(event) on the pre-recovery event. `dirty: true` means
   * at least one gap — this is what triggers the AI fallback. */
  validation: ValidationResult;
  /** Spec 013 — the stripped HTML subtree fed to the model, present only when
   * recovery actually ran and succeeded (source === 'ai-recovered'). The
   * publishable build persists this via the per-id recovered_html store; the
   * internal build ignores it. NEVER stored inline on the wire event. */
  recoveredHtml?: string;
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

interface CardMatch {
  fields: CardFields;
  /** The card's container element — the rich HTML context fed to the AI
   * fallback. Stripping the clicked button alone would give the model no
   * surrounding signal. */
  container: HTMLElement;
}

/**
 * Route an accept-button target to the right card. Tries the My Network
 * AcceptInvitationCard first (button is inside [role="listitem"]) then falls
 * back to ProfilePageAcceptCard (button sits in the profile header). Both
 * cards' fromAcceptButton constructors return null when their structural
 * conditions don't match, so the chain is safe.
 */
function findAcceptCard(target: HTMLElement, pageUrl: string): CardMatch | null {
  const invitation = AcceptInvitationCard.fromAcceptButton(target);
  if (invitation) {
    return {
      fields: {
        name: invitation.name,
        title: invitation.title,
        profileUrl: invitation.profileUrl,
        messageText: invitation.messageText,
      },
      container: invitation.container,
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
      fields: {
        name: profile.name,
        title: profile.title,
        profileUrl: profile.profileUrl,
        messageText: profile.messageText,
      },
      container: profile.container,
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
export async function extract(input: ExtractInput): Promise<ExtractResult> {
  if (input.eventType !== 'accepted_connection') {
    // Phase 4 only covers accept-connection. See file header for the
    // rationale; DM + connection_request flows continue to call cards
    // directly from content.ts until follow-up consolidation.
    throw new Error(
      `extract() does not yet support eventType="${input.eventType}" — phase 4 covers 'accepted_connection' only`,
    );
  }

  const match = findAcceptCard(input.target, input.pageUrl);
  const event = buildEvent('accepted_connection', match?.fields ?? null, input.pageUrl);
  const validation = validate(event);

  // Spec 013 — on-device AI fallback. Only when the selectors produced a dirty
  // result, the user opted in, and the model is locally available. recover()
  // never throws, so a null return cleanly degrades to a selectors-only row.
  if (validation.dirty && input.aiOptions?.enabled) {
    const availability = await getCachedAvailability();
    if (availability === 'available') {
      // Strip the card container when one matched; otherwise fall back to the
      // clicked element (e.g. no card found — recovery from whatever is there).
      const recoverTarget = match?.container ?? input.target;
      const trimmedHtml = stripHtmlForCarry(recoverTarget.outerHTML);
      if (trimmedHtml) {
        const result = await recover({
          trimmedHtml,
          candidate: event,
          gaps: validation.gaps,
          pageUrl: input.pageUrl,
        });
        if (result) {
          return {
            event: result.filledEvent,
            source: 'ai-recovered',
            validation,
            recoveredHtml: trimmedHtml,
          };
        }
      }
    }
  }

  return { event, source: 'selectors', validation };
}
