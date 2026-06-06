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
  ExtractContactTimeout,
  ExtractContactTooLarge,
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
  // Deliberately NO heuristic-candidate block: feeding the cheap heuristic's
  // guesses into the prompt anchors the model on them (it copied a wrong
  // "is a mutual connection" title and the wrong person's name verbatim). The
  // model reads the raw HTML itself; the heuristic survives only as the code-side
  // reconcile() fallback when the model returns null.
  //
  // Prompt tuned against the on-device eval (drag-link-inspector eval harness):
  //   - an anti-fabrication guard (small models invent titles/URLs when pushed
  //     to fill a field — "null over a guess"),
  //   - title null-when-absent (never invent a headline for a bare name),
  //   - message_text = the most recent message WE sent (the non-contact party),
  //   - stage only when the fragment actually shows an interaction.
  const owner = (input.ownerName ?? '').trim();
  // Identity block: lets the model tell OUR messages from the other person's in
  // a thread. When no name is configured, fall back to "the participant who is
  // NOT the primary contact" — still unambiguous in a 1:1 thread.
  const ownerBlock = owner
    ? [
        `The account owner (the person doing the capturing) is ${owner}. In a`,
        'message thread each message is attributed to whoever sent it; treat',
        `messages sent by ${owner} as "sent by the user".`,
        '',
      ]
    : [];
  const ownerRef =
    owner || 'the account owner (you — the thread participant who is NOT the primary contact)';

  return [
    'You are extracting a single contact from an HTML fragment a user selected',
    'from a web page (it could be from any site — a social profile, a directory,',
    'an email, a CRM, a search result).',
    '',
    'The fragment may mention MORE THAN ONE person. Extract only the PRIMARY',
    'contact — the person the fragment is centered on. The primary contact:',
    '  • is the main heading / the most prominent profile in the fragment,',
    '  • usually has a headline or role line AND often a location,',
    '  • is the target of any action control (Connect, Message, Follow,',
    '    View profile, Accept), and',
    '  • is the person whose profile link repeats throughout the fragment.',
    '',
    'IGNORE anyone who appears only incidentally — e.g. someone described as a',
    '"mutual connection", "followed by", a "people also viewed" / "people also',
    'searched" suggestion, a commenter, or an endorser. Such a person is NOT the',
    'contact even when their name is bold, linked, or emphasized. Bold/emphasis',
    'does NOT mark the primary contact.',
    '',
    'CRITICAL: Use ONLY information literally present in the HTML below. Do NOT',
    'invent, infer, or guess any value — no made-up titles, employers, or URLs.',
    'Whenever a field is not actually present, return null. Prefer null over a guess.',
    '',
    ...ownerBlock,
    `Page URL: ${input.pageUrl}`,
    '',
    'Extract these fields from the HTML below. Return null for any field genuinely',
    'not present for the primary contact.',
    '',
    '- name:                 the primary contact\'s display name (e.g. "Jane Doe").',
    '                        Strip badges, pronouns, degree suffixes, "1st"/"2nd".',
    `                        this field is NEVER ${ownerRef}`,
    '- title:                their current headline / role description (the',
    '                        descriptive line near their name), copied as-is from',
    '                        the fragment. If the contact has NO headline / role',
    '                        line present here, title is null — NEVER invent, guess,',
    '                        or fill in a plausible-sounding title. NEVER use a',
    '                        relational phrase about someone else such as "is a',
    '                        mutual connection".',
    '- linkedin_url:         the profile or page URL of the PRIMARY contact (the',
    '                        repeated one), NOT a URL belonging to an incidental',
    '                        person. Prefer a clean canonical URL; strip query',
    '                        strings and tracking params. Any site is valid — do',
    '                        NOT assume LinkedIn.',
    `- message_text:         The single most recent message written by ${ownerRef}.`,
    '                        The thread is ordered oldest-first, so the most recent',
    `                        message is the LAST one — nearest the BOTTOM of the text.`,
    `                        Do this in order:`,
    `                          1. Start at the BOTTOM of the thread and read upward.`,
    `                          2. Stop at the FIRST message whose sender is ${ownerRef}.`,
    `                          3. Return only that one message's text.`,
    `                        If the fragment is a single connection note (not a`,
    '                        thread), return that note instead.',
    `                        Then format the result as PLAIN TEXT: convert <br> to`,
    '                        newlines and remove all other HTML tags.',
    `                        Return null only if ${ownerRef} wrote nothing here.`,
    '- suggested_event_type: the interaction stage — but ONLY when THIS fragment',
    '                        actually shows an interaction. A plain profile, search',
    '                        result, or bare name with no conversation is null. One',
    '                        of: "accepted_connection" (a connection was just',
    '                        accepted — a greeting such as "Looking forward to',
    '                        connecting with you here" or "Thanks for connecting"',
    '                        indicates this, NOT a request), "connection_request"',
    '                        (an invite was sent), or "direct_message" (a real',
    '                        message was sent or received). Null if there is no such',
    '                        interaction or you cannot tell.',
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

/** An AbortSignal.timeout() abort surfaces as a DOMException named 'TimeoutError'
 *  (some builds use 'AbortError'); either means the model didn't answer in time. */
function isTimeoutError(err: Error): boolean {
  return err?.name === 'TimeoutError' || err?.name === 'AbortError';
}

/** prompt() rejects with a QuotaExceededError ("input is too large") when the
 *  prompt exceeds the model's context window — even after the strip-cap passes. */
function isTooLargeError(err: Error): boolean {
  return err?.name === 'QuotaExceededError';
}

export async function extractContact(
  input: ExtractContactInput,
): Promise<ExtractContactResult | ExtractContactTimeout | ExtractContactTooLarge | null> {
  try {
    if (typeof LanguageModel === 'undefined' || !LanguageModel) {
      console.log('[extractContact] EXIT: LanguageModel global is undefined in this context.');
      return null;
    }
    const availability = await LanguageModel.availability();
    if (availability !== 'available') {
      console.log(
        `[extractContact] EXIT: LanguageModel.availability() = "${availability}" (need "available").`,
      );
      return null;
    }

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
      // catch below turns into a tooLarge marker so the UI can warn the user.
      const promptText = buildPrompt(input);
      // Temporary: log the entire prompt sent to the on-device model so we can
      // inspect exactly what the AI sees during manual capture debugging.
      console.log('[extractContact] AI input prompt:\n' + promptText);
      const raw = await session.prompt(promptText, {
        signal: AbortSignal.timeout(PROMPT_TIMEOUT_MS),
        responseConstraint: RESPONSE_SCHEMA,
      });
      // Temporary: log the raw model output alongside the input above.
      console.log('[extractContact] AI raw output:\n' + raw);

      const parsed = parseExtraction(raw);
      if (!parsed) {
        console.log(
          '[extractContact] EXIT: parseExtraction returned null — output was empty, not JSON, ' +
            'or failed schema validation (see raw output above).',
        );
        return null;
      }

      return {
        fields: reconcile(input.candidate, parsed),
        suggested_event_type: coerceEventType(parsed.suggested_event_type),
      };
    } finally {
      session?.destroy?.();
    }
  } catch (err) {
    // D-AI-1 still holds (we resolve, never throw), but never silently — surface
    // the real failure (create()/prompt() rejection, timeout, QuotaExceededError…).
    // A timeout resolves to a distinct marker so the UI can warn the user rather
    // than degrade silently; every other failure resolves to null as before.
    if (isTimeoutError(err as Error)) {
      console.log('[extractContact] EXIT: timed out — surfacing timeout marker.', err);
      return { timedOut: true };
    }
    if (isTooLargeError(err as Error)) {
      console.log('[extractContact] EXIT: input too large — surfacing tooLarge marker.', err);
      return { tooLarge: true };
    }
    console.log('[extractContact] EXIT: threw, degrading to null. Error:', err);
    return null;
  }
}
