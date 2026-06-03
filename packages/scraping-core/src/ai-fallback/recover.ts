/**
 * recover() — on-device LLM field recovery (spec 013, Phase 2).
 *
 * Invoked by extract() when validate() flags a dirty result AND the user has
 * opted in AND the model is available. Builds a single hard-coded prompt,
 * constrains output to a JSON schema, reconciles the model's answer against
 * the scraper candidate, and returns a filled event.
 *
 * LOAD-BEARING INVARIANT (D-AI-1): recover() NEVER throws. Every failure mode —
 * absent/throwing LanguageModel, create() rejecting, prompt() rejecting, invalid
 * JSON, schema mismatch, model refusal, AbortSignal timeout, over-quota input —
 * resolves to null. The caller treats null as "selectors-only row; do not
 * persist recovered_html". Without this, an AI failure becomes a silent capture
 * failure — the class of bug spec 009 exists to eliminate.
 */

import type { PipelineEvent } from '../types.js';
import type { LanguageModelSession, RecoverInput, RecoverResult } from './types.js';

const CREATE_TIMEOUT_MS = 10_000;
const PROMPT_TIMEOUT_MS = 10_000;

/** D-AI matrix: scraper wins for linkedin_url only when it's a canonical /in/ URL. */
const LINKEDIN_PROFILE_RE = /^https?:\/\/(www\.)?linkedin\.com\/in\/[^/?#]+/;

/** Responses constrained to this schema. null ≠ "" (reconciliation depends on it). */
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: ['string', 'null'] },
    title: { type: ['string', 'null'] },
    linkedin_url: { type: ['string', 'null'] },
    message_text: { type: ['string', 'null'] },
  },
  required: ['name', 'title', 'linkedin_url', 'message_text'],
  additionalProperties: false,
} as const;

interface RawExtraction {
  name: string | null;
  title: string | null;
  linkedin_url: string | null;
  message_text: string | null;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function buildPrompt(input: RecoverInput): string {
  const c = input.candidate;
  return [
    'You are extracting structured fields from a fragment of LinkedIn DOM',
    'captured at the moment a user clicked Accept, Connect, or Send.',
    '',
    'A heuristic DOM scraper extracted these candidate values. They may be',
    'correct, partially correct, or completely wrong (the scraper sometimes',
    'picks up button labels, "Premium" badges, mutual-connection counts, or',
    'empty strings). Treat them as hints only — do not anchor on them.',
    '',
    'Scraper candidates (for reference only):',
    `  name:          ${JSON.stringify(c.name)}`,
    `  title:         ${JSON.stringify(c.title)}`,
    `  linkedin_url:  ${JSON.stringify(c.linkedin_url)}`,
    `  message_text:  ${JSON.stringify(c.message_text)}`,
    '',
    `Page URL: ${input.pageUrl}`,
    '',
    'Extract the following four fields independently from the HTML below.',
    'Return null for any field genuinely not present in the HTML.',
    '',
    '- name:         the display name (e.g. "Jane Doe"). Strip badges,',
    '                pronouns, degree suffixes, "1st"/"2nd" markers.',
    '- title:        the current headline / role description (one line).',
    '- linkedin_url: canonical profile URL https://www.linkedin.com/in/{handle}/.',
    '                Strip query strings and tracking params.',
    '- message_text: the optional note on a connection request, OR the text the',
    '                user typed into a message composer. Null if neither.',
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
  if (
    name === undefined ||
    title === undefined ||
    linkedinUrl === undefined ||
    messageText === undefined
  ) {
    return null;
  }
  return { name, title, linkedin_url: linkedinUrl, message_text: messageText };
}

/**
 * On-device reconciliation matrix (spec 013):
 *   name / title / message_text → AI wins; null falls back to the scraper value.
 *   linkedin_url → scraper wins if it's a canonical /in/ URL; otherwise AI wins.
 */
function reconcile(candidate: PipelineEvent, ai: RawExtraction): PipelineEvent {
  const linkedinUrl = LINKEDIN_PROFILE_RE.test(candidate.linkedin_url)
    ? candidate.linkedin_url
    : (ai.linkedin_url ?? candidate.linkedin_url);

  return {
    ...candidate,
    name: ai.name ?? candidate.name,
    title: ai.title ?? candidate.title,
    message_text: ai.message_text ?? candidate.message_text,
    linkedin_url: linkedinUrl,
  };
}

export async function recover(input: RecoverInput): Promise<RecoverResult | null> {
  try {
    if (typeof LanguageModel === 'undefined' || !LanguageModel) return null;
    if ((await LanguageModel.availability()) !== 'available') return null;

    let session: LanguageModelSession | null = null;
    try {
      session = await LanguageModel.create({
        signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
        expectedInputs: [{ type: 'text', languages: ['en'] }],
        expectedOutputs: [{ type: 'text', languages: ['en'] }],
      });

      // No up-front token measurement: measureContextUsage()/measureInputUsage()
      // is unreliable across Chrome builds (it stalls on some), and the
      // attribute-stripped input is small. prompt() enforces the real context
      // limit — an overflow throws QuotaExceededError, which the catch below
      // turns into a clean null (selectors-only row).
      const raw = await session.prompt(buildPrompt(input), {
        signal: AbortSignal.timeout(PROMPT_TIMEOUT_MS),
        responseConstraint: RESPONSE_SCHEMA,
      });

      const parsed = parseExtraction(raw);
      if (!parsed) return null;

      return { filledEvent: reconcile(input.candidate, parsed), warnings: [] };
    } finally {
      session?.destroy?.();
    }
  } catch {
    return null;
  }
}
