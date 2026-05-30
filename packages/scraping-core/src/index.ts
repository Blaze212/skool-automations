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

export type { DebugPayload, EventType, PipelineEvent } from './types.js';
