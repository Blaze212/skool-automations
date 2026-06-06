// Public API for the on-device AI extractor (spec 013 → generalized in spec 016).

export { extractContact } from './extract-contact.js';
export {
  stripHtmlForCarry,
  stripHtmlForCarryWithStatus,
  RECOVERED_HTML_CAP_BYTES,
  type CarryStripResult,
} from './strip-html.js';
export {
  getCachedAvailability,
  invalidateAvailabilityCache,
  refreshAvailability,
} from './availability.js';
export { downloadModel } from './download.js';
export type {
  AiAvailability,
  ContactFields,
  ExtractContactInput,
  ExtractContactResult,
  ExtractContactTimeout,
  ExtractContactTooLarge,
  LanguageModelSession,
  LanguageModelStatic,
} from './types.js';
