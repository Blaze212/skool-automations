# Pipeline Tracker — On-Device AI Field Recovery

**Status:** Draft
**Owner:** Barton Holdridge
**Last updated:** 2026-05-29

**Related (must be read first):**

- [006-pipeline-tracker.md](006-pipeline-tracker.md) — internal extension baseline
- [007-pipeline-tracker-result-feedback.md](007-pipeline-tracker-result-feedback.md) — badge +
  history; defines `HistoryEntry.warnings`
- [008-pipeline-tracker-ai-field-extraction.md](008-pipeline-tracker-ai-field-extraction.md) —
  server-side `gpt-5-nano` extraction in `pipeline-tracker-webhook` (internal build only)
- [009-pipeline-tracker-outbox-queue.md](009-pipeline-tracker-outbox-queue.md) — outbox + history
- [011-pipeline-tracker-scraping-core.md](011-pipeline-tracker-scraping-core.md) — **prereq**;
  provides `validate`, `extract`, the `Card` router, and the canonical `PipelineEvent` type
- [012-pipeline-tracker-publishable.md](012-pipeline-tracker-publishable.md) — consumes the
  `recovered_html` field added here for the publishable sync payload

---

## Objective

Add an on-device LLM fallback to the scraping pipeline. When the heuristic extractor returns a
"dirty" `ValidationResult` (missing required field or noisy title pattern), invoke Chrome's
`LanguageModel` API (Prompt API, Chrome 138+) to recover the missing fields from a trimmed HTML
subtree of the captured card.

Both extension builds opt in via `settings.ai_fallback_enabled` (default off):

- **Publishable build** uses this as its **only** AI extraction (it cannot send HTML to a
  backend by design).
- **Internal build** uses this as a first pass; spec 008's server-side `gpt-5-nano` is the
  second pass and overrides per the spec-008 reconciliation matrix.

The model is on-device; nothing leaves the browser. The recovered HTML subtree is persisted only
in the publishable build (for transit to the user's app) under a per-id keyed store — see spec
012 D-rev-28 for the storage shape.

---

## Non-goals

- **No automatic model download.** The Prompt API model is ~2 GB. When `availability` is
  `'downloadable'`, the user opts in via a UI toggle that triggers the download with a progress
  indicator.
- **No fallback to a different AI provider** when LanguageModel is unavailable. Result is a
  selectors-only row, same as today.
- **No changes to spec 008's server-side fallback.** Internal-build users with debug mode on
  continue to get the server-side reconciliation; this on-device pass runs *before* the
  webhook POST.
- **No telemetry.** Recovery rate is deducible from the `source` field on rows that reach the
  backend (spec 012 §D9).
- **No prompt-tuning UI.** Single hard-coded prompt, single schema.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ content.ts (in extension build, either internal or publishable)     │
│   ↓                                                                  │
│ @cs/scraping-core.extract({document, target, pageUrl, aiOptions}):  │
│   1. Card.from(target) → card                                        │
│   2. card.toEvent() → candidateEvent                                 │
│   3. validate(candidateEvent) → {dirty: boolean, gaps: Field[]}     │
│   4. if dirty                                                        │
│       AND aiOptions?.enabled === true                                │
│       AND cached availability === 'available':                       │
│         trimmedHtml = stripHtmlForCarry(target.outerHTML)            │
│         result = await recover({trimmedHtml, candidateEvent, gaps,  │
│                                  pageUrl})                           │
│         if result !== null:                                          │
│           candidateEvent = mergeFields(candidateEvent, result)       │
│           source = 'ai-recovered'                                    │
│           recoveredHtml = trimmedHtml                                │
│         else:                                                        │
│           source = 'selectors'                                       │
│           recoveredHtml = undefined                                  │
│   5. → {event: candidateEvent, source, recoveredHtml?, validation}   │
└─────────────────────────────────────────────────────────────────────┘
       ↓
┌─────────────────────────────────────────────────────────────────────┐
│ content.ts post-extract:                                             │
│   if recoveredHtml AND build === 'publishable':                      │
│     if !settings.capture_message_bodies AND card.isMessenger:        │
│       recoveredHtml = null     ← side-channel closure (D-rev-13)    │
│     if recoveredHtml: persist via storage.recoveredHtml.set(         │
│                                  historyId, recoveredHtml)          │
│   storage.outbox.enqueue(event)  (event carries source, NOT html)   │
└─────────────────────────────────────────────────────────────────────┘
```

The recovered HTML is **never** stored inline on `OutboxEntry` or `PipelineEvent` at rest.
Spec 012 D-rev-28 keeps it in a per-id keyed store so the hot outbox payload stays small.
Spec 012's sync-pull handler lazily attaches it back onto the wire-format `PipelineEvent` just
before returning to the app.

---

## The `recover()` contract

```ts
// packages/scraping-core/src/ai-fallback/recover.ts

export interface RecoverInput {
  trimmedHtml: string;          // stripped subtree, ≤ 16 KB
  candidate: Partial<PipelineEvent>;  // current scraper output (hints, not anchors)
  gaps: ValidationGap[];        // which fields validate() flagged
  pageUrl: string;
}

export interface RecoverResult {
  filledEvent: PipelineEvent;
  warnings: string[];           // [] on clean success; populated on partial recovery
}

export async function recover(input: RecoverInput): Promise<RecoverResult | null>;
```

**Load-bearing guarantee:** `recover()` **never throws**. Every internal failure — availability
check throwing, `LanguageModel.create()` throwing, `prompt()` rejecting, JSON schema mismatch,
model refusal, 10 s `AbortSignal` timeout, OOM-style promise rejection — returns `null`. The
caller treats `null` as "selectors-only row; do not persist `recovered_html`." All caught errors
get recorded in `HistoryEntry.warnings` via the warnings sink the caller passes in (or just
dropped — implementer's choice; the spec doesn't require warnings to surface in the popup).

This is the single most important invariant of this spec. Without it, an AI failure becomes a
silent capture failure — exactly the class of bug spec 009 was written to eliminate.

---

## Prompt + JSON schema

Single hard-coded prompt. Output is constrained via `responseConstraint` (Prompt API feature)
to a JSON schema. Schema must distinguish `null` (field not present) from `""` (empty string),
mirroring spec 008's reconciliation matrix.

```json
{
  "type": "object",
  "properties": {
    "name":         { "type": ["string", "null"] },
    "title":        { "type": ["string", "null"] },
    "linkedin_url": { "type": ["string", "null"] },
    "message_text": { "type": ["string", "null"] }
  },
  "required": ["name", "title", "linkedin_url", "message_text"],
  "additionalProperties": false
}
```

Prompt body (abbreviated):

> Extract four fields from this LinkedIn DOM fragment. Treat the candidate values as hints, not
> anchors. Return `null` for fields not present.
> - **name** — display name; strip badges, "1st"/"2nd" markers, pronouns.
> - **title** — current headline / role; one line.
> - **linkedin_url** — canonical `/in/{handle}/` URL; strip query + tracking params.
> - **message_text** — connection-request note or compose textbox content; `null` if neither.
>
> Candidate values: name=`{candidate.name}`, title=`{candidate.title}`,
> linkedin_url=`{candidate.linkedin_url}`, message_text=`{candidate.message_text}`.
> Page: `{pageUrl}`.
> HTML: `{trimmedHtml}`.

### Reconciliation (on-device side)

| Field          | Rule on-device                                                       |
| -------------- | -------------------------------------------------------------------- |
| `name`         | AI wins. If AI returns `null`, the final value is the scraper's.     |
| `title`        | AI wins. Same null fallback.                                         |
| `message_text` | AI wins. Same null fallback.                                         |
| `linkedin_url` | Scraper wins if it matches `^https?://(www\.)?linkedin\.com/in/[^/?#]+`. Otherwise AI wins. |

The publishable build's reconciliation lives here; the internal build's server-side step (spec
008) re-runs reconciliation against the webhook-side `gpt-5-nano` output and may override
again.

---

## Runtime guards

| Concern | Approach |
|---|---|
| Stability gate | Prompt API is stable for extensions in **Chrome 138+** with no special manifest permission required today. `responseConstraint` (JSON schema output) is Chrome 137+. CI guard #2 (below) re-checks at build time and fails if a permission is reintroduced. |
| Per-event `availability()` cost | Cached for 5 min. Invalidated on explicit user toggle or on download completion. |
| Model state `'available'` | Use it. |
| Model state `'downloadable'` | Do NOT auto-trigger. Settings UI surfaces a "Download model (~2 GB)" button. |
| Model state `'downloading'` | Treat as unavailable; selectors-only row. |
| Model state `'unavailable'` | Selectors-only row. |
| Session memory | Fresh `LanguageModel.create()` per `recover()` call. Bounded. Pass an `AbortSignal` to `create()` so a caller cancellation tears down the in-flight session. |
| Hang protection on `prompt()` | Each `session.prompt()` wrapped in `AbortSignal.timeout(10_000)`. |
| Hang protection on `measureInputUsage()` | Same — pass `{signal: AbortSignal.timeout(5_000)}`. This call can hang on degraded model state and is on the hot path. |
| Input quota | `session.measureInputUsage(trimmedHtml, {signal})` before `prompt()`; if over `session.inputQuota`, return `null` instead of prompting. |
| Download progress | `LanguageModel.create({monitor(m) { m.addEventListener('downloadprogress', e => ui.setProgress(Math.round(e.loaded * 100))) }})`. `e.loaded` is a fraction 0–1. |

`stripHtmlForCarry()` (below) handles input sizing — the model's quota is ~4-6k tokens and a
trimmed card subtree is ~400-2,000 tokens, well within bounds.

---

## `stripHtmlForCarry` helper

A single function used in three places (DRY — covers spec 012 CQ-obs-1):

```ts
// packages/scraping-core/src/ai-fallback/strip-html.ts

export const RECOVERED_HTML_CAP_BYTES = 16 * 1024;

export function stripHtmlForCarry(subtreeHtml: string): string {
  // 1. Parse into a detached DOM (DOMParser).
  // 2. Remove all <script>, <svg>, <img>, <style>, <link>, <iframe> elements.
  // 3. Collapse whitespace runs in text nodes.
  // 4. Serialize back to a string.
  // 5. If result.length > RECOVERED_HTML_CAP_BYTES, return '' (caller drops with warning).
}
```

Callers:
1. `recover()` to prep the model input (this spec).
2. The publishable capture path to persist `recovered_html_<history_id>` after the model returns
   (spec 012 D-rev-28).
3. CSV export (spec 012 D7) — re-reads from the keyed store; strip already happened at persist
   time, so this caller does nothing extra.

---

## Storage additions

```ts
// packages/scraping-core/src/types.ts (or pipeline-tracker/src/types.ts; promoted in 011)

export interface Settings {
  // ...existing keys (spec 012 D5)
  ai_fallback_enabled: boolean;       // default false; user opt-in
  ai_model_downloaded: boolean;       // tracks whether user accepted the ~2 GB download
}
```

The `recovered_html_<history_id>` per-id keys are defined in spec 012 D-rev-28; this spec is
their **writer** in the publishable build. Internal build never writes them (the webhook
re-extracts server-side per spec 008, so client-side HTML carry-through is unnecessary).

---

## Side-channel closure (D-rev-13)

When `settings.capture_message_bodies === false` AND the card classification is a messenger
card (`MessengerPageCard` or `ChatOverlayCard`), `recovered_html` is dropped before persist —
**even though `recover()` was invoked and its field values are used.** Closes the leak path
where `recovered_html` would carry the very message bodies the toggle was meant to suppress.

This logic lives at the capture call site in the publishable build's `content.ts`, NOT inside
`recover()` — the recovery itself is content-neutral; the suppression is a privacy policy applied
at persist time.

---

## Implementation phases

Each phase ships as ONE PR sized to ~200-400 lines of diff. Internal extension build must
continue to function after every phase — but with `ai_fallback_enabled` defaulting to false,
no AI code runs unless the user opts in, so there is no rollout risk to existing users.

### Phase 1 — Strip helper + capability detection (~250 lines)

- `packages/scraping-core/src/ai-fallback/strip-html.ts` — `stripHtmlForCarry` + cap constant.
- `packages/scraping-core/src/ai-fallback/availability.ts` — 5-min cached wrapper around
  `LanguageModel.availability()`. Exposes `getCachedAvailability()` + `invalidateAvailabilityCache()`.
- Mock `LanguageModel` in tests via `tests/__mocks__/language-model.ts`.
- Unit tests: strip removes each banned tag; cap enforcement; cache hit/miss.
- No call sites yet. Pure scaffolding.

### Phase 2 — `recover()` core (~400 lines)

- `packages/scraping-core/src/ai-fallback/recover.ts` — prompt construction, schema, session
  lifecycle, `AbortSignal.timeout`, OOM rejection handling, never-throws contract.
- `packages/scraping-core/src/ai-fallback/index.ts` — public API.
- Unit tests covering every failure mode:
  - `availability()` throws → `null`.
  - `availability` returns `'unavailable'` / `'downloadable'` / `'downloading'` → `null`
    (each branch).
  - `LanguageModel.create()` throws → `null`.
  - `session.prompt()` rejects synchronously → `null`.
  - `session.prompt()` returns invalid JSON → `null`.
  - `session.prompt()` returns JSON failing schema → `null`.
  - Model refusal (empty string or refusal marker) → `null`.
  - 10 s `AbortSignal` fires → `null`.
  - `measureInputUsage` over quota → `null`.
- Each test asserts `recover()` resolved with `null` and never threw.

### Phase 3 — Wire into `extract.ts` (~250 lines)

- `packages/scraping-core/src/extract.ts` (from spec 011) gains an optional `aiOptions` param:
  ```ts
  interface ExtractInput {
    document: Document;
    target: HTMLElement;
    pageUrl: string;
    aiOptions?: {
      enabled: boolean;          // settings.ai_fallback_enabled
      // Future hook for callers that want to inject availability or recover for tests.
    };
  }
  ```
- When `validate().dirty === true` AND `aiOptions.enabled === true` AND
  `getCachedAvailability() === 'available'`, call `recover()`.
- Merge per the on-device reconciliation rules (table above).
- Stamp `source: 'ai-recovered'` on the result. Attach `recoveredHtml` to `ExtractResult`.
- Tests:
  - `extract()` with AI disabled returns selectors-only for dirty events.
  - `extract()` with AI enabled and `recover()` returning fields → `source = 'ai-recovered'`.
  - `extract()` with AI enabled and `recover()` returning `null` → `source = 'selectors'`,
    no `recoveredHtml`.

### Phase 4 — Storage + per-id recovered_html persistence (~250 lines)

- `pipeline-tracker/src/storage.ts` (from spec 012 Phase 1) gains:
  ```ts
  recoveredHtml.set(historyId, html): Promise<void>
  recoveredHtml.get(historyId): Promise<string | null>
  recoveredHtml.remove(historyId): Promise<void>
  ```
- `content.ts` (publishable build branch): after `extract()` returns with `recoveredHtml`, call
  `recoveredHtml.set(historyId, html)` if and only if persist criteria are met (see Phase 5
  for the side-channel closure).
- 16 KB cap re-checked at persist boundary (defense in depth — `stripHtmlForCarry` enforces
  but a buggy caller might bypass).
- Tests: set/get/remove round-trip; 16 KB cap; quota-exceeded path returns `STORAGE_QUOTA`
  history row (spec 012 D-rev-11).

### Phase 5 — Side-channel closure + capture wiring (~200 lines)

- In `pipeline-tracker/src/content.ts` (publishable branch), at the persist call site:
  ```ts
  let recoveredHtml = extractResult.recoveredHtml ?? null;
  if (recoveredHtml && card.isMessenger && !settings.capture_message_bodies) {
    recoveredHtml = null;  // D-rev-13
  }
  if (recoveredHtml) {
    await storage.recoveredHtml.set(historyId, recoveredHtml);
  }
  ```
- `Card` (router from spec 011) gains an `isMessenger: boolean` getter on the card instance.
- Tests:
  - Messenger card + `capture_message_bodies: false` → `recoveredHtml` not persisted.
  - Messenger card + `capture_message_bodies: true` → persisted.
  - Non-messenger card + `capture_message_bodies: false` → persisted (toggle only affects
    messenger).

### Phase 6 — Settings UI + model-download toggle (~350 lines)

- Side panel (publishable) AND popup (internal) gain a Settings section.
- "Enable on-device AI recovery" checkbox toggles `settings.ai_fallback_enabled`.
- On opt-in, probe `LanguageModel.availability()`:
  - `'available'` → done; checkbox stays checked.
  - `'downloadable'` → show "Download model (~2 GB)" CTA; on click, trigger download with a
    progress indicator (`LanguageModel.create({monitor})` emits download progress events).
  - `'downloading'` → show progress; disable checkbox until done.
  - `'unavailable'` → gray out the checkbox with tooltip "Chrome 138+ required."
- On settings change, invalidate the availability cache (`invalidateAvailabilityCache()`).
- Tests: UI in each state; download initiation; cache invalidation.

### Phase 7 — Golden fixture tests (~350 lines)

- `tests/fixtures/ai-fallback/*.html` — at least 5 captured DOM snippets from real LinkedIn
  events (PII-scrubbed) covering:
  - Connection request with a noisy "Premium" title.
  - Connection request with a missing title.
  - Messenger DM with full body.
  - Profile-page accept flow.
  - Chat-overlay send.
- Each fixture has a sibling `*.expected.json` with the expected `RecoverResult.filledEvent`.
- Test harness: load fixture → `stripHtmlForCarry` → mock `LanguageModel` to return the
  expected JSON → assert `recover()` produces the expected event.
- These tests catch prompt drift without shipping production telemetry (§D9 in spec 012).

---

## CI guards

1. **Prompt API symbol isolation** — `grep -rn "LanguageModel\.\(create\|availability\)"
   pipeline-tracker/src/` returns zero matches; only `packages/scraping-core/src/ai-fallback/`
   may reference them.
2. **Permission drift** — Prompt API for extensions does NOT require a special manifest
   permission today (Chrome 138+). The build script re-reads Chrome's Prompt API docs at
   build time (24h cache) and fails if the page now lists a required permission that
   `manifest.publishable.json` is missing. Forward-looking guard against an
   `aiLanguageModel`-style permission reintroduction.

---

## Acceptance criteria

1. `settings.ai_fallback_enabled = false` (default) → every event has `source: 'selectors'`;
   `recovered_html_*` keys are never written.
2. `ai_fallback_enabled = true` AND `availability = 'available'`:
   - dirty events trigger `recover()`.
   - clean events skip `recover()`.
   - reconciliation matrix produces expected `filledEvent` for golden fixtures.
3. `recover()` returns `null` for every failure mode covered in Phase 2 tests; the caller
   always produces a selectors-only row, never throws.
4. `recover()` 10 s timeout returns `null` within 10.5 s (timer slack).
5. Messenger card + `capture_message_bodies = false` → `recovered_html` not persisted.
6. `recovered_html` after strip exceeding 16 KB → dropped with warning; no key written.
7. `availability = 'downloadable'` does NOT auto-trigger download; UI surfaces the toggle.
8. Settings UI flips the setting and (where applicable) initiates download.
9. Golden fixture tests pass.
10. Internal extension behavior is unchanged when AI is disabled.
11. Publishable extension behavior is unchanged when AI is disabled (selectors-only sync).

---

## Decisions log

These decisions were originally in spec 012 (formerly 010) and are owned here:

- **D-AI-1 (was D-rev-10).** `ai-fallback.recover()` never throws to the caller. Every internal
  error (availability check, create, prompt, schema mismatch, refusal, timeout, OOM) returns
  `null`. The caller produces a selectors-only row. Original AI errors may be appended to
  `HistoryEntry.warnings` by the caller.
- **D-AI-2 (was D-rev-13).** Side-channel closure: when `settings.capture_message_bodies ===
  false` AND the card is a messenger card, `recovered_html` is dropped from the persisted event
  regardless of whether AI fallback ran. Recovered field VALUES (from the selectors-only output
  of the AI call) are still used; the HTML evidence is not carried.
- **D-AI-3 (was D-rev-15).** Each `session.prompt()` call inside `recover()` is wrapped in a
  10 s `AbortSignal` timeout. Timeout returns `null`.
- **D-AI-4 (was D-rev-16).** `recovered_html` is capped at 16 KB after the strip pass. Anything
  larger is dropped from the event with `HistoryEntry.warnings: ['recovered_html exceeded 16KB
  cap']`. The cap constant lives in `strip-html.ts`.
- **D-AI-5 (was D-rev-32).** AI fallback coverage: per-error-mode unit tests + golden-fixture
  prompt tests. The fixture corpus catches prompt drift even though §D9 (spec 012) declines to
  ship telemetry.
- **D-AI-6.** `stripHtmlForCarry` is a single shared helper used by `recover()`, the capture
  persist path, and (transitively) CSV export. DRY closure of spec 012 CQ-obs-1.
- **D-AI-7.** `LanguageModel.availability()` result is cached for 5 minutes; cache is
  invalidated when the user toggles `ai_fallback_enabled` or after a model download completes.

---

## Open questions

1. **Should `recover()` warnings surface in the popup/side panel?** Today they're an unused
   field on `RecoverResult`. Probably leave at `[]` in v1.0; revisit if a user complains "AI
   failed but I don't know why."
2. **Per-card prompt tuning?** Different cards produce different DOM shapes; a single prompt
   may underperform on edge cases. Defer until golden fixtures reveal it's worth the
   complexity.
3. **Internal-build server-side overlay (spec 008) — should it skip the on-device pass when
   ai_fallback_enabled is also on?** Currently both run; spec-008 reconciliation overrides
   on-device output for internal builds. Costs a few hundred ms of latency. Acceptable for the
   internal evaluation window; revisit if it bites in production.

---

## Best-practice references

Implementers MUST consult these before each phase. Memory notes live under
`/home/agent/.claude/projects/.../memory/`; verify currency at implementation time.

| Topic | Memory note | Applies to phases |
|---|---|---|
| Chrome Prompt API (availability, create, prompt, monitor, AbortSignal, responseConstraint) | `chrome-prompt-api` | 1, 2, 6 |
| MV3 SW lifecycle interaction with AI calls (each prompt fits in the 30 s idle window) | `chrome-mv3-sw-lifecycle` | 2, 3 |
| `chrome.storage.local` quota — per-id keyed store keeps payloads small | `chrome-storage` | 4 |
| Web Store program policy on AI disclosure | `chrome-web-store-policy` | covered by spec 012 Phase 12 |

Key consequences already encoded in this spec:

- **`AbortSignal` on every async call** — `create()`, `prompt()`, AND `measureInputUsage()`.
  Hangs are silent otherwise.
- **`responseConstraint` (Chrome 137+) for JSON output** — schema-enforced, not
  prompt-engineered.
- **No special manifest permission required today** for Prompt API in extensions; CI guard
  re-checks at build time.
- **`monitor` event with `addEventListener('downloadprogress', e => …)`** — `e.loaded` is a
  fraction 0–1.
- **Cache `availability()` for 5 min** and invalidate on user toggle or download completion.
