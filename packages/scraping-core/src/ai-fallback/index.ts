// Public API for the on-device AI extractor (spec 013 → generalized in spec 016).

export { extractContact } from './extract-contact.js';
export { stripHtmlForCarry, RECOVERED_HTML_CAP_BYTES } from './strip-html.js';
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
  LanguageModelSession,
  LanguageModelStatic,
} from './types.js';
