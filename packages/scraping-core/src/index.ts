// Public API surface for @cs/scraping-core.
//
// Spec 016 retired the LinkedIn DOM-scraping path (Cards + the extract()
// orchestrator). What remains is the shared wire types, the validation helper,
// and the on-device AI extractor (`extractContact`, promoted from spec 013's
// LinkedIn-anchored `recover()` to the primary, site-agnostic extractor) plus
// its HTML-strip / availability / download helpers.

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

export type {
  DebugPayload,
  EventType,
  ExtractionSource,
  PipelineEvent,
  ScrapeConfidence,
} from './types.js';

export {
  extractContact,
  stripHtmlForCarry,
  RECOVERED_HTML_CAP_BYTES,
  getCachedAvailability,
  invalidateAvailabilityCache,
  refreshAvailability,
  downloadModel,
  type AiAvailability,
  type ContactFields,
  type ExtractContactInput,
  type ExtractContactResult,
  type LanguageModelSession,
  type LanguageModelStatic,
} from './ai-fallback/index.js';
