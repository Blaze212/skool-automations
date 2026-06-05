/**
 * extractContact() — on-device contact extraction (spec 016).
 *
 * Promoted from spec 013's LinkedIn-anchored `recover()` AI *fallback* to the
 * *primary*, site-agnostic extractor for manual capture. Takes a stripped HTML
 * fragment a user dragged/pasted from any web page plus the heuristic candidate,
 * constrains the model to a JSON schema, reconciles the answer, and returns the
 * filled contact fields plus a suggested stage.
 *
 * LOAD-BEARING INVARIANT (D-AI-1): extractContact() NEVER throws. Every failure
 * mode — absent/throwing LanguageModel, create()/prompt() rejecting, invalid
 * JSON, schema mismatch, model refusal, AbortSignal timeout, over-quota input —
 * resolves to null. The caller treats null as "heuristic values stand"; the
 * card is always editable, so nothing is ever dropped.
 */

import type { EventType } from '../types.js';
import { AI_OUTPUT_LANGUAGE } from './types.js';
import type {
  ContactFields,
  ExtractContactInput,
  ExtractContactResult,
  LanguageModelSession,
} from './types.js';

const CREATE_TIMEOUT_MS = 10_000;
const PROMPT_TIMEOUT_MS = 10_000;

const EVENT_TYPES = new Set<EventType>([
  'connection_request',
  'accepted_connection',
  'direct_message',
]);

/** Responses constrained to this schema. null ≠ "" (reconciliation depends on it). */
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: ['string', 'null'] },
    title: { type: ['string', 'null'] },
    linkedin_url: { type: ['string', 'null'] },
    message_text: { type: ['string', 'null'] },
    suggested_event_type: { type: ['string', 'null'] },
  },
  required: ['name', 'title', 'linkedin_url', 'message_text', 'suggested_event_type'],
  additionalProperties: false,
} as const;

interface RawExtraction {
  name: string | null;
  title: string | null;
  linkedin_url: string | null;
  message_text: string | null;
  suggested_event_type: string | null;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function buildPrompt(input: ExtractContactInput): string {
  const c = input.candidate;
  return [
    'You are extracting a single contact from an HTML fragment a user selected',
    'from a web page (it could be from any site — a social profile, a directory,',
    'an email, a CRM, a search result).',
    '',
    'A cheap heuristic already pulled these candidate values. They may be',
    'correct, partially correct, or wrong (the heuristic sometimes grabs button',
    'labels, badges, follower counts, or empty strings). Treat them as hints',
    'only — do not anchor on them.',
    '',
    'Heuristic candidates (for reference only):',
    `  name:          ${JSON.stringify(c.name)}`,
    `  title:         ${JSON.stringify(c.title)}`,
    `  linkedin_url:  ${JSON.stringify(c.linkedin_url)}`,
    `  message_text:  ${JSON.stringify(c.message_text)}`,
    '',
    `Page URL: ${input.pageUrl}`,
    '',
    'Extract these fields independently from the HTML below. Return null for any',
    'field genuinely not present.',
    '',
    '- name:                 the contact\'s display name (e.g. "Jane Doe").',
    '                        Strip badges, pronouns, degree suffixes, "1st"/"2nd".',
    '- title:                their current headline / role description (one line).',
    '- linkedin_url:         the profile or page URL for this contact. Prefer a',
    '                        clean canonical URL; strip query strings and tracking',
    '                        params. Do NOT assume LinkedIn — any site is valid.',
    '- message_text:         any message / note text the user wrote or received in',
    '                        this fragment. Null if none.',
    '- suggested_event_type: your best guess at the interaction stage, one of',
    '                        "connection_request" (a connection/invite was sent),',
    '                        "accepted_connection" (a connection was accepted), or',
    '                        "direct_message" (a message was sent or received).',
    '                        Null if you cannot tell.',
    '',
    'HTML:',
    input.trimmedHtml,
  ].join('\n');
}

function readField(obj: { [key: string]: JsonValue }, key: string): string | null | undefined {
  if (!(key in obj)) return undefined;
  const value = obj[key];
  if (value === null) return null;
  if (typeof value === 'string') return value;
  return undefined;
}

/** Parse + schema-validate the model output. Returns null on any deviation. */
function parseExtraction(raw: string): RawExtraction | null {
  if (!raw || !raw.trim()) return null; // empty string ⇒ model refusal

  let parsed: JsonValue;
  try {
    parsed = JSON.parse(raw) as JsonValue;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const name = readField(parsed, 'name');
  const title = readField(parsed, 'title');
  const linkedinUrl = readField(parsed, 'linkedin_url');
  const messageText = readField(parsed, 'message_text');
  const suggested = readField(parsed, 'suggested_event_type');
  if (
    name === undefined ||
    title === undefined ||
    linkedinUrl === undefined ||
    messageText === undefined ||
    suggested === undefined
  ) {
    return null;
  }
  return {
    name,
    title,
    linkedin_url: linkedinUrl,
    message_text: messageText,
    suggested_event_type: suggested,
  };
}

/** A "clean canonical URL" the heuristic yielded — an absolute https URL. */
function isCleanUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Review S-1 — `responseConstraint` enum annotations may be ignored by Chrome,
 * so re-validate the model's `suggested_event_type` against the real union and
 * coerce anything else (including null/garbage) to null.
 */
function coerceEventType(value: string | null): EventType | null {
  return value !== null && EVENT_TYPES.has(value as EventType) ? (value as EventType) : null;
}

/**
 * Reconciliation (de-LinkedIn — D-016-4):
 *   name / title / message_text → AI wins; null falls back to the candidate.
 *   linkedin_url → prefer the heuristic's clean canonical URL when it has one,
 *                  else the AI's URL (no linkedin.com anchoring).
 */
function reconcile(candidate: ContactFields, ai: RawExtraction): ContactFields {
  const linkedin_url = isCleanUrl(candidate.linkedin_url)
    ? candidate.linkedin_url
    : (ai.linkedin_url ?? candidate.linkedin_url);

  return {
    name: ai.name ?? candidate.name,
    title: ai.title ?? candidate.title,
    message_text: ai.message_text ?? candidate.message_text,
    linkedin_url,
  };
}

export async function extractContact(
  input: ExtractContactInput,
): Promise<ExtractContactResult | null> {
  try {
    if (typeof LanguageModel === 'undefined' || !LanguageModel) return null;
    if ((await LanguageModel.availability()) !== 'available') return null;

    let session: LanguageModelSession | null = null;
    try {
      session = await LanguageModel.create({
        signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
        outputLanguage: AI_OUTPUT_LANGUAGE,
        expectedInputs: [{ type: 'text', languages: [AI_OUTPUT_LANGUAGE] }],
        expectedOutputs: [{ type: 'text', languages: [AI_OUTPUT_LANGUAGE] }],
      });

      // No up-front token measurement: measureInputUsage() stalls on some Chrome
      // builds and the attribute-stripped input is small. prompt() enforces the
      // real context limit — an overflow throws QuotaExceededError, which the
      // catch below turns into a clean null (heuristic values stand).
      const raw = await session.prompt(buildPrompt(input), {
        signal: AbortSignal.timeout(PROMPT_TIMEOUT_MS),
        responseConstraint: RESPONSE_SCHEMA,
      });

      const parsed = parseExtraction(raw);
      if (!parsed) return null;

      return {
        fields: reconcile(input.candidate, parsed),
        suggested_event_type: coerceEventType(parsed.suggested_event_type),
      };
    } finally {
      session?.destroy?.();
    }
  } catch {
    return null;
  }
}
