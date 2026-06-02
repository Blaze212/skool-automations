// Public API for the on-device AI fallback (spec 013).

export { recover } from './recover.js';
export { stripHtmlForCarry, RECOVERED_HTML_CAP_BYTES } from './strip-html.js';
export {
  getCachedAvailability,
  invalidateAvailabilityCache,
  refreshAvailability,
} from './availability.js';
export { downloadModel } from './download.js';
export type {
  AiAvailability,
  LanguageModelSession,
  LanguageModelStatic,
  RecoverInput,
  RecoverResult,
} from './types.js';
