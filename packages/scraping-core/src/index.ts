// Public API surface for @cs/scraping-core.
// Populated by spec 011. Phase 4 adds the extract() orchestrator; Phase 5
// adds ExtractionSource + the CI guard.

export {
  AcceptInvitationCard,
  Card,
  type CardClass,
  ChatOverlayCard,
  MessengerPageCard,
  ProfilePageAcceptCard,
  SalesNavLeadCard,
  SalesNavMenuCard,
  SalesNavConnectModalCard,
} from './cards/index.js';

export {
  validate,
  type ValidationGap,
  type ValidationGapCode,
  type ValidationResult,
  DEGREE_MARKER_RE,
  MUTUAL_CONNECTION_RE,
  PREMIUM_BADGE_RE,
  OPEN_TO_WORK_RE,
  FOLLOWER_COUNT_RE,
} from './validate.js';

export {
  extract,
  type AiRecoveryOptions,
  type ExtractEventHint,
  type ExtractInput,
  type ExtractResult,
} from './extract.js';

export type {
  DebugPayload,
  EventType,
  ExtractionSource,
  PipelineEvent,
  ScrapeConfidence,
} from './types.js';

export {
  recover,
  stripHtmlForCarry,
  RECOVERED_HTML_CAP_BYTES,
  getCachedAvailability,
  invalidateAvailabilityCache,
  refreshAvailability,
  downloadModel,
  type AiAvailability,
  type LanguageModelSession,
  type LanguageModelStatic,
  type RecoverInput,
  type RecoverResult,
} from './ai-fallback/index.js';
