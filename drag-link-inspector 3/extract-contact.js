// Standalone port of packages/scraping-core/src/ai-fallback/extract-contact.ts
// for the eval. NO build step: plain ES module loaded by eval.html, run in an
// extension page where Chrome's on-device `LanguageModel` (Gemini Nano) global
// exists — exactly the surface the pipeline-tracker sidepanel uses.
//
// The response schema + parse/coerce logic below mirror production. The PROMPT
// is the iteration surface: refining buildPrompt() HERE and re-running the eval
// is a faithful preview of the shipped pipeline. Once validated, port the same
// buildPrompt() back into production extract-contact.ts.
//
// NOTE: this buildPrompt() is currently AHEAD of production — it adds (1) an
// ${ownerName} identity block + "most recent message WE sent" rule for
// message_text, (2) "Pending = invite sent" / greeting = accepted_connection
// hints for suggested_event_type, and (3) "copy the entire headline verbatim"
// for title. Port these back when satisfied with the eval scores.
//
// Difference from production: we do NOT reconcile against a heuristic candidate
// (the eval has no candidate — it scores the model's raw extraction against the
// truth labels). null is preserved (not coerced to '') so the scorer can treat
// "model said null" and "truth is null" as a match.

const CREATE_TIMEOUT_MS = 15_000; // a touch higher than prod (10s) — cold model
const PROMPT_TIMEOUT_MS = 20_000; // headroom for the longer message-thread cases

const EVENT_TYPES = new Set(['connection_request', 'accepted_connection', 'direct_message']);

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
};

// ─── Prompt (rev 2) — port to production extract-contact.ts when satisfied ────
function buildPrompt(input) {
  const owner = (input.ownerName || '').trim();
  // Identity block only emitted when the owner's name is known — lets the model
  // tell OUR messages from the other person's in a thread (message_text rule).
  const ownerBlock = owner
    ? [
        `The account owner (the person doing the capturing) is ${owner}. In a`,
        'message thread each message is attributed to whoever sent it; treat',
        `messages sent by ${owner} as "sent by the user".`,
        '',
      ]
    : [];
  const ownerRef = owner || 'the account owner (the person capturing this)';

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
    `- message_text:         a message or note in this fragment. If this is a`,
    '                        conversation / message thread, return ONLY the text of',
    `                        the MOST RECENT message sent by ${ownerRef}.`,
    '                        IGNORE messages from the other person, and ignore',
    `                        ${ownerRef}'s earlier messages — return only their`,
    '                        latest one. If the fragment is a single connection',
    '                        note, return that. Return PLAIN TEXT: convert <br> to',
    '                        newlines and drop any HTML tags. Null if there is no',
    '                        such message.',
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
// ─────────────────────────────────────────────────────────────────────────────

function readField(obj, key) {
  if (!(key in obj)) return undefined;
  const value = obj[key];
  if (value === null) return null;
  if (typeof value === 'string') return value;
  return undefined;
}

/** Parse + schema-validate the model output. Returns null on any deviation. */
function parseExtraction(raw) {
  if (!raw || !raw.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
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

function coerceEventType(value) {
  return value !== null && EVENT_TYPES.has(value) ? value : null;
}

/**
 * Run the on-device model over one eval input. Returns:
 *   { ok: true, extraction, ms, raw }   on success
 *   { ok: false, reason, ms }           on any failure (mirrors prod's null path)
 */
export async function runExtraction(input) {
  const t0 = performance.now();
  const elapsed = () => Math.round(performance.now() - t0);
  try {
    if (typeof LanguageModel === 'undefined' || !LanguageModel) {
      return { ok: false, reason: 'LanguageModel global is undefined in this context', ms: elapsed() };
    }
    const availability = await LanguageModel.availability();
    if (availability !== 'available') {
      return { ok: false, reason: `availability() = "${availability}" (need "available")`, ms: elapsed() };
    }

    let session = null;
    try {
      session = await LanguageModel.create({
        signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
        outputLanguage: 'en',
        expectedInputs: [{ type: 'text', languages: ['en'] }],
        expectedOutputs: [{ type: 'text', languages: ['en'] }],
      });

      const promptText = buildPrompt(input);
      const raw = await session.prompt(promptText, {
        signal: AbortSignal.timeout(PROMPT_TIMEOUT_MS),
        responseConstraint: RESPONSE_SCHEMA,
      });

      const parsed = parseExtraction(raw);
      if (!parsed) {
        return { ok: false, reason: 'parse/schema-validation failed', ms: elapsed(), raw };
      }
      parsed.suggested_event_type = coerceEventType(parsed.suggested_event_type);
      return { ok: true, extraction: parsed, ms: elapsed(), raw };
    } finally {
      session?.destroy?.();
    }
  } catch (err) {
    return { ok: false, reason: String(err?.message || err), ms: elapsed() };
  }
}

export { buildPrompt };
