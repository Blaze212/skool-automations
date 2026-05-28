# Pipeline Tracker — AI-Assisted Field Extraction from Debug Payload

**Status:** Draft
**Owner:** Barton Holdridge
**Last updated:** 2026-05-27
**Related:** `006-pipeline-tracker.md`, `007-pipeline-tracker-result-feedback.md`

## Objective

The heuristic DOM scraper in `pipeline-tracker/src/content.ts` has known gaps: it occasionally
misses optional connection-request notes, picks up noise (e.g. "Premium", mutual-connection
counts) instead of titles, and sometimes returns empty strings for fields that are clearly
present in the surrounding DOM.

When the user has debug mode enabled, the plugin already captures a 10,000-char `container_html`
chunk from the page and forwards it to the webhook (today: only when scraping fails). This spec
extends that flow so the webhook **always** invokes `gpt-5-nano` on the captured HTML when a
debug payload is present, and uses the model's structured output as the authoritative source for
`name`, `title`, and `message_text`, with a per-field override for `profile_url`.

The result: cleaner spreadsheet rows during the evaluation window with no change to the LinkedIn
page's DOM footprint and no change to the popup status semantics.

---

## Non-goals

- No change to non-debug-mode behavior. Clients without debug mode on continue to write
  scraper-only data, exactly as today.
- No retroactive backfill of past rows.
- No model selection toggle, temperature controls, or per-client prompt overrides — single
  hardcoded prompt, single model (`gpt-5-nano`).
- No streaming. The webhook awaits the full LLM response before responding to the plugin.
- No plugin UI changes beyond the existing badge/history surfaces from spec 007.

---

## Current behavior (as of 2026-05-27)

### Frontend (`pipeline-tracker/src/content.ts`)

Three call sites currently build and attach the debug payload only when the local scraper failed:

```ts
const debugMode = await getDebugMode();
const debug = debugMode && scrapeFailed ? buildDebugPayload(el, debugContainer) : undefined;
```

Locations: `content.ts:430-437`, `content.ts:489-492`, `content.ts:672-675`.

`buildDebugPayload` (`content.ts:74-81`) returns:

```ts
{
  button_aria_label: string,
  button_text: string,
  container_html: string,  // capped at 10000 chars
  page_url: string,
}
```

### Backend (`supabase/functions/linkedin-tracker-webhook/linkedin-tracker-webhook.ts`)

The webhook receives `debug?: DebugPayload` and currently only logs it:

```ts
if (body.debug) {
  log.info({ debug: body.debug }, 'debug payload received');
}
```

It then writes scraper-provided `name`, `title`, `message_text`, `profile_url` to the
spreadsheet verbatim.

There is **no** OpenAI client in `supabase/functions/_shared/` today — this spec introduces one.

---

## Design

### Frontend change — always send debug payload when debug mode is on

Drop the `scrapeFailed` gate at all three call sites. When debug mode is enabled, the plugin
unconditionally attaches `container_html` so the backend can always run AI extraction:

```ts
const debug = debugMode
  ? buildDebugPayload(el, debugContainer)
  : undefined;
```

No other changes to `content.ts`. The popup toggle, storage key, and cached-flag plumbing all
already exist.

### Backend change — AI extraction pipeline

When `body.debug?.container_html` is present:

1. Call `extractFieldsFromHtml(html, page_url, scrapedCandidates)` → returns
   `{ name, title, profile_url, message_text }`, each `string | null`.
2. Reconcile against scraper-provided values per the field-level matrix below.
3. Write the reconciled values to the spreadsheet.
4. Log both raw inputs (scraper + AI) and the reconciled output for evaluation.

When no debug payload is present, behavior is unchanged — scraper values flow directly to the
spreadsheet.

### Reconciliation matrix

| Field          | Rule                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------- |
| `name`         | **AI wins.** If AI returns `null`, the final value is `''` (nullify scraper).                |
| `title`        | **AI wins.** If AI returns `null`, the final value is `''` (nullify scraper).                |
| `message_text` | **AI wins.** If AI returns `null`, the final value is `''` (nullify scraper).                |
| `profile_url`  | **Scraper wins** if its value matches `/^https?:\/\/(www\.)?linkedin\.com\/in\/[^/?#]+/`. Otherwise fall back to AI; otherwise `''`. |

Rationale for `profile_url` exception: the scraper reads it directly from an `href` attribute,
which is structurally more reliable than asking a model to extract a URL from text content.

### New shared utility — `supabase/functions/_shared/openai.ts`

A minimal Deno-native OpenAI client. No SDK; just `fetch` against the Responses API. Reads
`OPENAI_API_KEY` via `loadSupabaseEnv` (extending the env loader to expose it).

```ts
export interface OpenAiClient {
  extractStructured<T>(args: {
    model: string;
    prompt: string;
    schema: Record<string, unknown>;  // JSON Schema, root must be object
    maxOutputTokens?: number;
  }): Promise<T>;
}

export function createOpenAiClient(): OpenAiClient;
```

Errors throw `OpenAiException` (already defined in `_shared/errors.ts`) with the upstream
status and message as `sourceError`.

### New helper — `extractFieldsFromHtml`

Lives next to the webhook handler, e.g.
`supabase/functions/linkedin-tracker-webhook/extract-fields.ts`:

```ts
export interface ExtractedFields {
  name: string | null;
  title: string | null;
  profile_url: string | null;
  message_text: string | null;
}

export interface ScrapedCandidates {
  name: string;
  title: string;
  profile_url: string;
  message_text: string;
}

export async function extractFieldsFromHtml(
  openai: OpenAiClient,
  html: string,
  pageUrl: string,
  scraped: ScrapedCandidates,
): Promise<ExtractedFields>;
```

#### Prompt

```
You are extracting structured fields from a fragment of LinkedIn's DOM
captured at the moment a user clicked Accept, Connect, or Send.

A heuristic DOM scraper extracted these candidate values. They may be
correct, partially correct, or completely wrong (the scraper sometimes
picks up button labels, "Premium" badges, mutual-connection counts, or
empty strings). Treat them as hints only — do not anchor on them.

Scraper candidates (for reference only):
  name:          "{scraped.name}"
  title:         "{scraped.title}"
  profile_url:   "{scraped.profile_url}"
  message_text:  "{scraped.message_text}"

Page URL: {pageUrl}

Extract the following four fields independently from the HTML below.
Return null for any field genuinely not present in the HTML.

- name:         the person's display name (e.g. "Jane Doe"). Strip badges,
                pronouns, degree suffixes, "1st"/"2nd" connection markers.
- title:        the person's current headline / role description (one line).
- profile_url:  their canonical LinkedIn profile URL, of the form
                https://www.linkedin.com/in/{handle}/. Strip query strings
                and tracking params.
- message_text: the optional note attached to a connection request, OR
                the text the user just typed into a message composer. If
                neither is present, return null.

HTML:
{html}
```

#### JSON Schema (Responses API `text.format.json_schema`)

```json
{
  "type": "object",
  "properties": {
    "name":         { "type": ["string", "null"] },
    "title":        { "type": ["string", "null"] },
    "profile_url":  { "type": ["string", "null"] },
    "message_text": { "type": ["string", "null"] }
  },
  "required": ["name", "title", "profile_url", "message_text"],
  "additionalProperties": false
}
```

Important: schema must distinguish `null` (field not present) from `""` (empty string).
Reconciliation logic depends on this distinction.

### Webhook integration

In `linkedin-tracker-webhook.ts`, between the api_key lookup and the sheets append:

```ts
let reconciled = {
  name: body.name,
  title: body.title,
  profile_url: body.profile_url ?? '',
  message_text: body.message_text,
};

if (body.debug?.container_html) {
  const openai = createOpenAiClient();
  const llm = await extractFieldsFromHtml(
    openai,
    body.debug.container_html,
    body.page_url ?? '',
    {
      name: body.name,
      title: body.title,
      profile_url: body.profile_url ?? '',
      message_text: body.message_text,
    },
  );

  reconciled = {
    name:         llm.name ?? '',
    title:        llm.title ?? '',
    message_text: llm.message_text ?? '',
    profile_url:  isValidLinkedInProfileUrl(body.profile_url)
                    ? (body.profile_url as string)
                    : (llm.profile_url ?? ''),
  };

  log.info(
    { scraped: { ...body, debug: undefined }, llm, reconciled },
    'ai-extraction reconciled',
  );
}

// existing sheets.appendRow uses `reconciled` instead of `body`
```

`isValidLinkedInProfileUrl` is a one-line regex helper.

### Concurrency

No special handling needed. Each webhook invocation runs in its own Supabase edge function
instance; the OpenAI call is an isolated outbound `fetch`. Multiple concurrent clicks fire
independent webhook requests, each with its own LLM round-trip. OpenAI's API handles parallel
requests; the existing rate limits on `gpt-5-nano` are generous enough that single-user
clickstreams will not approach them.

### Latency

Adding a synchronous `gpt-5-nano` call adds roughly 400–900ms per debug-mode event. The popup
already shows status asynchronously after the webhook responds (spec 007), so this delay is
visible to the user as "row appears in spreadsheet slightly later" and "popup history entry
appears slightly later." Acceptable during the evaluation window.

**Cost gate:** if/when debug mode is enabled for non-evaluator clients, this changes from "Barton
absorbs the latency and cost" to "every client pays for every click." Re-evaluate before that
flip.

### Popup status semantics

No change. The popup colorizes based on the webhook's `success`/`error` response shape from
spec 007. Reconciled values flow into the spreadsheet but the response body to the plugin is
unchanged. A future enhancement could surface `enriched_by_llm: true` in the history entry; out
of scope here.

---

## Environment / configuration

- `OPENAI_API_KEY` — new secret. Add to Doppler for local dev and to GitHub Actions / Supabase
  function secrets for production. Update `_shared/env.ts` to expose it via a typed loader.
- Model: `gpt-5-nano` (hardcoded). If we later need to swap, change in one place.
- No new database tables, no new RLS policies, no migrations.

---

## Code touchpoints

| File                                                                       | Change                                                                                  |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `pipeline-tracker/src/content.ts`                                          | Drop `scrapeFailed &&` gate at three debug-payload build sites (lines 437, 491, 675)    |
| `supabase/functions/_shared/openai.ts` (new)                               | Deno-native OpenAI Responses API client; structured-output helper                       |
| `supabase/functions/_shared/env.ts`                                        | Expose `OPENAI_API_KEY` via the env loader                                              |
| `supabase/functions/linkedin-tracker-webhook/extract-fields.ts` (new)      | `extractFieldsFromHtml` + prompt + schema                                               |
| `supabase/functions/linkedin-tracker-webhook/linkedin-tracker-webhook.ts`  | Wire AI call between api_key lookup and sheets append; reconciliation; structured log   |
| `tests/unit/functions/linkedin-tracker-webhook.test.ts`                    | Existing tests updated for reconciliation; new tests cover AI on/off, per-field matrix  |
| `tests/unit/functions/extract-fields.test.ts` (new)                        | Schema validation, null vs empty-string handling, prompt construction                   |
| `tests/__mocks__/openai.ts` (new, if needed)                               | Mock OpenAI client for unit tests                                                       |

No changes to: `manifest.json`, `background.ts`, `popup/*`, the four `*-card.ts` files,
`pipeline-tracker/build.ts`, any migration.

---

## Acceptance criteria

1. **Frontend, debug ON:** every captured event (accept, connection request, DM) ships
   `debug.container_html` to the webhook, regardless of whether the scraper succeeded. Verify
   by tailing the webhook logs while clicking through a dozen events.

2. **Frontend, debug OFF:** no debug payload is ever sent. The webhook log line for
   `'debug payload received'` never fires. Verify by toggling off and repeating step 1.

3. **AI extraction runs only when debug payload is present:** webhook logs show
   `'ai-extraction reconciled'` for every debug-mode request and never for non-debug-mode
   requests.

4. **Reconciliation — AI wins for text fields:** in a captured event where the scraper returned
   `title: "Premium"` (noise) and the AI returned `title: "Head of Growth at Acme"`, the
   spreadsheet row contains `"Head of Growth at Acme"`.

5. **Reconciliation — AI null nullifies scraper:** in a captured event where the scraper
   returned `message_text: "1st degree connection"` (noise) and the AI returned
   `message_text: null`, the spreadsheet row contains `""`, not the scraped string.

6. **Reconciliation — scraper wins for valid profile_url:** when the scraper returned a valid
   `https://www.linkedin.com/in/jane-doe/` and the AI returned `null` or a different URL, the
   spreadsheet row contains the scraper's URL.

7. **Reconciliation — AI fallback for invalid profile_url:** when the scraper returned `''` or
   a non-`/in/` URL, and the AI returned a valid `/in/` URL, the spreadsheet row contains the
   AI's URL.

8. **Message-text extraction from connection-request note:** a connection request with an
   optional "Add a note" message records that note in column K of the spreadsheet, even when
   the scraper missed it.

9. **Latency budget:** debug-mode requests complete in under 2 seconds end-to-end (P95) under
   normal OpenAI conditions. Non-debug requests are unchanged (~200ms).

10. **Failure mode — OpenAI down:** if the OpenAI call throws, the webhook returns
    `502 OPENAI_ERROR` via the existing `OpenAiException` path. No spreadsheet row is written.
    The plugin popup surfaces this as a red error per spec 007.

11. **Host DOM unchanged:** the LinkedIn page's `document.documentElement.outerHTML` is
    byte-identical with and without debug mode (no new DOM mutations from this spec).

---

## Open questions

- **Should an OpenAI failure block the row write, or fall back to scraper values?** Current
  design blocks (acceptance #10) so failures are visible during evaluation. Once the feature is
  stable, fall-back-to-scraper may be the better default to avoid losing rows on transient AI
  outages.
- **Should the reconciled output also include a confidence signal per field?** Could be useful
  later for the popup to display "low confidence — verify in sheet." Out of scope for this spec.
- **Shadow-mode for non-debug clients?** Once we trust the model, we could fire AI extraction
  on every request (no debug payload needed — just send `container_html` always). That's a
  separate spec; this one stays gated on debug mode.
- **Token-budget cap on `container_html`?** Already capped at 10,000 chars in
  `buildDebugPayload`. `gpt-5-nano`'s context window handles this comfortably; revisit only if
  we raise the cap.
