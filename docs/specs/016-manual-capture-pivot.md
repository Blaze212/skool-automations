# Spec 016 — Manual Capture Pivot (drag / paste → AI → card)

**Status:** Reviewed (spec-reviewer 2026-06-05; CEO/plan review 2026-06-05, HOLD SCOPE; eng-review 2026-06-05) — MVP-first
**Owner:** Barton
**Last updated:** 2026-06-05

---

## Eng-review decisions (2026-06-05, BIG CHANGE)

Eleven issues across architecture / code-quality / tests / performance; scope held, all resolved.

1. **Phase ordering (E-1).** Fold the Phase-3 deletion of `extract.ts` + `cards/*` + `content.ts`
   scraping **into the same commit** that generalizes `recover.ts` → `extractContact()` (Phase 2).
   The old LinkedIn-anchored contract must never have a live caller — generalizing in place while
   `extract.ts:194` still calls it would ship a broken/dual-contract intermediate commit.
2. **Paste boundary (E-2).** The capture-`paste` handler is scoped to a **focusable drop-zone
   element** (`tabindex`), NOT document-level. Pastes into the card's Message field stay native, so
   "paste message text manually" (Objective) and "paste to capture" (D-016-1) don't collide.
3. **Capture state machine (E-3).** `capture-section.ts` is an explicit 4-state machine
   `Empty → Extracting(locked) → Ready/Editing → Saving`. A new drop while Ready-with-unsaved-edits
   → **confirm "Replace current card?"**; a drop while Extracting → **ignored** (brief toast). Embed
   an inline ASCII diagram. Card-lock release MUST be in a `finally` so a thrown/rejected extraction
   still unlocks (no silent stuck-card). The Stage dropdown defaults to **`connection_request`** when
   `suggested_event_type` is null (visibly preselected, user-overridable).
4. **Confidence DRY (E-4).** When Phase 3 deletes `content.ts` (the only `scoreCapture()` caller),
   **delete `scoreCapture()` + its tests**; `heuristicConfidence()` becomes the single confidence
   function (reusing `isPlausibleName`/`NAME_RE`/junk). No dead-but-tested duplicate.
5. **`recovered_html` dormant, not "the gift" (E-5).** After Phase 3 nothing writes `recovered_html`.
   Leave the machinery for this PR but correct the "reused unchanged" framing to mark it
   **dormant — no producer**, and file a TODO to decide strip vs. repurpose-for-server-AI-fallback
   (the latter re-opens Decision 3's Limited-Use posture; see TODOS.md). Server AI is only an
   auto-fill-quality nicety — heuristic + always-editable card already make on-device-AI-unavailable
   degrade gracefully.
6. **`review-section.ts` framing (E-6).** It is **not** "reused as the capture editor" — the reused
   piece is `editable-fields.ts`; the editor is the new `capture-section.ts`. `review-section.ts`
   stays mounted only for the legacy-coexistence window (Decision 7); TODO to delete it once beta
   users drain legacy held-back rows.
7. **Eval scope (E-7).** The prompt **did** change (LinkedIn → generic + `suggested_event_type`) and
   the model is now **primary**, so spec-015 Decision 7's "no eval rerun" no longer applies. Commit a
   **small real-fragment fixture set** (~6–10 fragments: LinkedIn + 2–3 other sites) + a documented
   manual spot-check against the real on-device model; CI keeps the mocked plumbing tests. (Full
   scored eval harness deferred to GA — TODOS.md.)
8. **State-machine tests (E-8).** Full transition coverage for E-3 (confirm-replace yes/no,
   ignore-during-extract, save, and **extraction-error → card unlocks**).
9. **Added test gaps (E-9), obvious adds:** (a) paste into a card field does NOT re-capture (E-2
   negative); (b) `isSafeProfileUrl()` rejects `javascript:`/`data:`/`chrome-extension:` schemes
   (security regression guard when generalizing `isSafeLinkedInUrl`); (c) `page_url` dropped-but-
   wire-still-valid.
10. **Fragment cap (E-10).** Pin the pre-parse raw cap to **64 KB** (truncate at a tag boundary if
    cheap, else byte-cut) as one named constant; document the pipeline
    `raw ≤64KB → DOMParser → stripHtmlForCarry ≤16KB → AI`.
11. **ADR (E-11).** No `docs/adr/` dir exists yet — create it and file the manual-capture-pivot ADR
    (Acceptance criterion already requires it).

---

## CEO review decisions (2026-06-05, HOLD SCOPE)

Seven issues raised and resolved; scope held, hardened for correctness/observability.

1. **Typed `enqueueManualCapture()` helper (D-016-5/6).** The manual-capture wire invariant
   (`scrape_confidence:'high'`, `needs_review:false`, `user_reviewed:true`, `api_key:''`, fresh
   `history_id`) is enforced by a single typed helper in `storage.ts`, **not** by discipline in
   `capture-section.ts`. That file is a recurring-edit hotspot (5 of the last 9 commits touched the
   AI-fallback/review surface); a comment-only invariant there is a silent-regression risk. The
   helper calls `setOutboxAndHistory` and cannot construct a wrong row. Unit-tested once.
2. **Save-path failure is visible (D-016-6 / Phase 1).** `enqueueManualCapture` catches
   `StorageQuotaExceededError` and the `OUTBOX_CAP` (50) full case, **keeps the card populated**
   (no data loss), and shows an **inline panel error** ("Couldn't save — sync or clear synced
   items, then retry"). Tested.
3. **Manual captures NEVER persist/sync `recovered_html` (D-016-6, security).** Save **always**
   uses `setOutboxAndHistory` — never `setOutboxHistoryAndRecoveredHtml`. The dropped fragment can
   be arbitrary private content from any site, and S-7 already says the server skips enrichment for
   high-confidence rows, so it has **no server consumer**. Keeping it on-device honors the
   Limited-Use claim and simplifies the save path. The AI's *output* lives in the card fields; the
   raw HTML is dropped after extraction.
4. **Card locks during extraction (new D-016-7).** Auto-AI fires on low-confidence captures and can
   take ≤20s. The card shows an "Extracting…" state and **disables inputs (and the Extract button)**
   until the model resolves/times out, then populates once — so a user edit can never be clobbered
   by a late AI write. Tested.
5. **Site-agnostic `heuristicConfidence()` (D-016-2).** `scoreCapture()`'s URL gate is
   `linkedin.com/in/`-only, so reusing it verbatim makes every non-LinkedIn capture permanently
   low-confidence (AI on *every* capture). Add a small `heuristicConfidence()`: plausible name
   (reuse the site-agnostic `NAME_RE`/junk set) **and** a non-empty `https:` URL present → `'high'`
   (skip AI); else `'low'` (run AI). AI becomes a true fallback; the lock is the exception.
   `scoreCapture()` stays untouched/dead per D-016-5.
6. **In-repo wire-shape contract test (Acceptance).** `tracker-import`, the `pipeline`/`jobsearch`
   state machines, and the parity-oracle fixtures live in the sibling `careersystems` repo — not
   here — so the old criterion was unverifiable in this CI. Instead: commit a representative wire
   fixture (the exact field set `tracker-import` consumes) and assert `enqueueManualCapture`'s
   output matches it byte-for-byte. Cross-repo state-machine verification is explicitly out of band.
7. **Legacy held-back review rows — orphan risk accepted (Phase 3).** A user upgrading from the
   scraper build with low-confidence scraped rows (`needs_review && !user_reviewed`) still in the
   outbox could orphan them if the review-queue mount is removed. Accepted: document that users
   should **sync/clear before upgrading**; no migration code.

Folded in without a separate decision: cap the dropped fragment (~32–64KB) before `DOMParser`/AI to
avoid panel jank on whole-page selections; add structured logs at capture-received / AI-invoke+result /
save-outcome; update `recover.ts`'s LinkedIn-anchored reconciliation comment when generalizing.
**Target:** MVP beta — same handful of users as spec 015, sideloaded extension
**Builds on:** [015-tracker-unification](./015-tracker-unification.md) (unified external build, binding auth, `tracker-import`, server-side `pipeline`/`jobsearch` state machines)

---

## Objective

Replace the pipeline-tracker's automated LinkedIn DOM click-scraping with **manual,
site-agnostic capture**. The user selects an element on *any* web page and **drags it
into the side panel** (or copies and pastes it). The dropped `text/html` fragment is
parsed by a cheap heuristic and, when needed, the on-device **Gemini `LanguageModel`**
(today's `recover()`, promoted from AI *fallback* to *primary* extractor) into
`{ name, title, profile_url, message_text }`. The user reviews the prefilled CRM card,
pastes any message text manually, and **picks the stage from a dropdown** (the AI
suggests a default). Saving enqueues exactly the same wire `PipelineEvent` the backend
already consumes — so the entire server side of spec 015 is unchanged.

The pivot trades zero-effort automatic capture for: **site-agnosticism, Chrome Web Store
publishability, no LinkedIn-ToS scraping risk, and the elimination of silent scraper
breakage** (every capture is now user-in-the-loop by construction).

## Non-goals

- **No automated / background capture.** No click listeners, no DOM observers, no
  "capture as you browse." Capture happens only on an explicit user drag or paste.
- **No re-introduction of page content scripts for scraping.** The MVP needs **no
  content script and no `host_permissions` at all** (drag lands in the side panel; see
  D-016-1). An optional in-page drop affordance is parked in Phase 4.
- **No multi-contact bulk drop in the MVP.** One drop = one card. A selection spanning
  several people extracts the primary contact; splitting a multi-row selection into many
  cards is a fast-follow (Phase 4).
- **No backend / edge-function changes.** The wire `PipelineEvent` contract is
  unchanged; `tracker-import` and the spec-015 `pipeline`/`jobsearch` state machines
  consume manual captures identically to scraped ones (D-016-3).
- **No new server AI.** Extraction is 100% on-device (built-in `LanguageModel`).

## Business Rationale

Spec 015 unified three trackers but kept the brittle, LinkedIn-only, ToS-grey scraper at
the input edge — which is exactly what blocks a Chrome Web Store listing and what fails
silently when LinkedIn ships DOM changes. The expensive infrastructure (on-device AI,
outbox/sync, binding, review queue, badge, CSV) is **already built and tested** and does
not depend on *how* fields are acquired. Swapping the acquisition path from
"click-scrape LinkedIn" to "user drags any element → AI extracts" is therefore mostly
**deletion**, and it removes the two structural blockers to publishing (LinkedIn host
permissions + automated scraping) in one move.

## Architecture

### Headline: the wire contract does not change

The reusable core is `packages/scraping-core/src/ai-fallback/recover.ts`. It already takes
an **HTML fragment** + scraper candidate and returns `{ name, title, linkedin_url,
message_text }` via built-in `LanguageModel` constrained to a JSON schema, with the
load-bearing **never-throws** invariant (D-AI-1). A user-initiated drag serializes the
selection into a `DataTransfer` carrying `text/html` (full markup, absolute hrefs) +
`text/plain` — the same fragment shape `recover()` already eats. We promote it to the
primary path and feed it the dropped/pasted HTML instead of a scraped container.

Because the resulting `PipelineEvent` is byte-identical in shape to today's, **nothing
server-side changes**. `event_type` now comes from a human picking a dropdown rather than
from inferred click context, but it lands in the same field and drives the same state
machines.

### D-016-1 — Capture surface: drag-into-side-panel (no content script)

A user-initiated drag is an **OS-level** drag carrying `text/html` / `text/plain` /
`text/uri-list` across window and renderer boundaries (proven: dragging a LinkedIn
selection into other apps transfers full markup; the user's `drag-link-inspector` MVP
confirms the side-panel drop specifically). The side panel is an ordinary
`chrome-extension://` document; a `drop` handler reads `dataTransfer.getData('text/html')`.

Consequences:
- **No content script, no `host_permissions`.** Capture is "page emits native drag → side
  panel drop zone reads it." Cleanest possible Web Store review surface.
- **Paste is a parallel input** for the same payload: on `paste`,
  `clipboardData.getData('text/html')` carries identical rich markup.

> **Spike gate (Phase 0):** a throwaway drop-zone confirms the side-panel document fires
> `drop` with a populated `dataTransfer`. The user's MVP already demonstrates this; the
> spike just re-confirms inside *this* extension's panel before we delete the scraper.

### D-016-2 — Two-tier extraction (heuristic fast-path → AI)

1. **Heuristic (no AI, instant):** `DOMParser.parseFromString(html, 'text/html')` the
   fragment (scripts are inert by construction — never use `innerHTML` on the payload);
   pull the first `a[href]` (profile/page URL), nearest heading / `<strong>` text (name),
   and the next text line (title). Reuse `score-capture.ts`'s `NAME_RE` / junk set to
   score it.
   Confidence is scored by a new **site-agnostic `heuristicConfidence()`** (CEO-review decision 5):
   plausible name (reuse the site-agnostic `NAME_RE`/junk set) **and** a non-empty `https:` URL
   present → `'high'`; else `'low'`. Do **not** reuse `scoreCapture()` here — its `linkedin.com/in/`
   URL gate would force `'low'` on every non-LinkedIn capture. Cap the fragment (~32–64KB) before
   parsing to avoid panel jank on whole-page selections.
2. **AI (on-device, when heuristic is low-confidence OR user requests):** the generalized
   extractor (below) repairs/fills the fields. While extraction is in flight the card is **locked
   with an "Extracting…" state** (decision 4) so a late AI write can't clobber a user edit. AI
   unavailable or failing → heuristic values stand; the card is always editable, so nothing is ever
   dropped.

### D-016-3 — Stage dropdown = `event_type` (manual, AI-suggested)

The wire `event_type` (`connection_request | accepted_connection | direct_message`) is
unchanged. The side-panel card adds a **Stage dropdown** mapping friendly labels to those
values:

| Dropdown label | wire `event_type` |
|---|---|
| Sent connection request | `connection_request` |
| Connection accepted | `accepted_connection` |
| Sent / received a message | `direct_message` |

The AI returns a **`suggested_event_type`** (new optional field on the extractor's schema)
from the message/context; the dropdown defaults to it but the user can override. This
feeds the spec-015 server state machines unchanged:
- **`jobsearch`** layout: `event_type` → Connect→Accepted→DM monotonic ladder (direct).
- **`pipeline`** layout: server still classifies `message_text` (Skool/$200k phrases) for
  Branch-taken; the pasted message text is the same input the classifier already expects.

### D-016-4 — Generalize `recover()` → `extractContact()` (de-LinkedIn)

Promote and generalize the module (Cards/`extract.ts` are deleted in Phase 3, so the
fallback contract is free to change). `extractContact()` **fully replaces** `extract()` —
it does not wrap it. (`extract.ts:170` throws synchronously for any non-`accepted_connection`
event type, and that throw is *outside* `recover()`'s never-throws boundary; leaving a
call path to it would reintroduce an uncaught throw — review S-5.)
- **Prompt:** "extract a contact (display name, title/role, profile-or-page URL, and any
  message text) from this HTML fragment a user selected from a web page" — no LinkedIn
  framing. Keep URL canonicalization but **do not anchor on `linkedin.com`**: the
  client `LINKEDIN_PROFILE_RE` scraper-wins rule becomes "prefer a clean canonical URL
  when the fragment yields one, else AI's URL."
- **Schema:** add optional
  `suggested_event_type: 'connection_request' | 'accepted_connection' | 'direct_message' | null`.
  **Treat it as untrusted output:** Chrome's `responseConstraint` may ignore JSON-schema
  `enum` annotations, so `reconcile()` MUST re-validate the value against the three
  `EventType`s and coerce anything else to `null` (review S-1). The never-throws D-AI-1
  invariant is preserved — any extraction failure still resolves to `null` and the card
  falls back to heuristic values.
- **`RecoverInput.gaps`** is vestigial in the manual flow (`buildPrompt()` never reads it).
  Pass `[]`; remove the param from the signature if cheap (review S-4).
- **Wire field naming:** the `PipelineEvent.linkedin_url` field name is **kept** (back-compat
  with `tracker-import` + sheets); the UI label becomes "Profile / page URL". A rename is
  a separate, optional follow-up — out of scope here to keep the diff additive.

> **Server-side reconciliation is NOT de-anchored.** `tracker-import`'s `enrich.ts:44`
> independently applies the same `LINKEDIN_PROFILE_URL_RE` scraper-wins rule. For a
> non-LinkedIn capture the scraper URL isn't a `/in/` URL, so the server keeps the AI URL
> — the desired behavior — and a real LinkedIn `/in/` URL captured manually is still
> preserved. Internally consistent, **no backend change needed**, but called out so the
> "zero backend work" claim is honest (review B-4).

### D-016-5 — Captures are pre-reviewed; `needs_review` is repurposed

In spec 015, low scrape-confidence flagged a row into the Part-B **review queue**. With
manual capture the **card editor *is* the review step** — every saved event is
`user_reviewed = true` by construction. The existing review-queue UI
(`review-section.ts`) and `editable-fields.ts` are reused as the **capture card editor**
rather than a separate post-hoc queue.

**Critical invariant (review B-3):** the manual save path sets
`{ scrape_confidence: 'high', needs_review: false, user_reviewed: true }` **explicitly**
and **bypasses `scoreCapture()`**. `scoreCapture()`'s `PROFILE_URL_RE` only matches
`linkedin.com/in/…`, so on a site-agnostic URL it would return `'low'` and wrongly route
every capture into the held-back review queue. With the invariant upheld, sync-pull's
`needs_review && !user_reviewed` skip (background-external.ts:144) and the review-badge
count (`countPendingReview`, background.ts:141) both correctly treat manual captures as
ready — they flow straight to the unsynced list and sync. `scoreCapture()` loses its only
caller when content.ts is stripped in Phase 3: **keep it** (dependency-free, still unit-
tested) but it is no longer on the capture path.

**Coexistence window (review S-3):** during Phases 1–2 the legacy scraper path and the new
manual path share one outbox. The skip logic handles both — legacy low-confidence rows stay
held back, manual `user_reviewed` rows flow — so partial rollout is safe.

**Server enrichment (review S-7):** manual captures arrive `scrape_confidence: 'high'`, so
`enrich.ts` skips on-device-redundant server AI for them. Intended (the card was already
AI-processed locally), noted so it isn't mistaken for a regression.

### D-016-6 — Wire field population contract (review-hardened)

The new `capture-section.ts` builds the `PipelineEvent` directly (not content.ts), so each
required field needs an explicit source. The shape is unchanged; only the origin moves.

| Field | Manual-flow value | Notes |
|---|---|---|
| `api_key` | `''` (empty literal) | Legacy field; absent from `tracker-import`'s `TrackerEvent` — backend ignores it. Required `string` in TS, so set `''` or typecheck fails (review B-1). Update the `PipelineEvent.api_key` comment to mark it legacy-empty in the JWT flow. |
| `event_type` | Stage dropdown (D-016-3) | Human-selected; AI default. |
| `date` | today (`toISOString().slice(0,10)`) | **Vestigial server-side:** `run-sheet.ts` writes sheet Date columns from its own wall clock, not this field. UI must not imply the *captured* date lands in the sheet (review B-2). |
| `page_url` | best-effort active tab (D-016-1 / Phase 1) | Not used for dedup. |
| `name`/`title`/`linkedin_url`/`message_text` | heuristic → AI → user-edited | `linkedin_url` may be any-site URL. |
| `history_id` | fresh UUID per capture | Server dedups on `(user_id, history_id)`. |
| `scrape_confidence` | `'high'` (set, not computed) | See D-016-5 — do **not** route through `scoreCapture()`. |

**Save path:** new captures go through the typed **`enqueueManualCapture()`** helper
(CEO-review decision 1), which **always** calls `setOutboxAndHistory(...)` — **never**
`setOutboxHistoryAndRecoveredHtml` (decision 3: no off-device HTML) and **never**
`reviewOutboxEntry()` (its `OutboxReviewEdits` shape at storage.ts:744 omits `event_type` and
would drop the dropdown selection — review N-4). The helper hard-codes the wire invariant and
catches storage-quota / full-outbox failures, surfacing an inline panel error while leaving the
card populated (decision 2).

### Reused unchanged (the gift)

`storage.ts` outbox facade (`setOutboxAndHistory`, `setOutboxHistoryAndRecoveredHtml`,
`reviewOutboxEntry`, `markOutboxReviewed`), `background.ts` message routing + binding
handshake + badge, sync-pull to the app, CSV export, settings (incl. AI download UI),
`editable-fields.ts`. **No backend changes** — `tracker-import` and both 015 state
machines consume the identical wire event.

### Removed (~2,800 LOC, ~47% of the extension)

- All LinkedIn `Card` extractors in `packages/scraping-core/src/cards/*` and the
  `extract()` orchestrator.
- The `linkedin-tracker` dependency (reused Card patterns).
- `content.ts` click/keydown interception, flow handlers
  (`handleConnectionRequest` / `handleAcceptConnection` / `handleDirectMessage` /
  Sales-Nav handlers), dedup staging, DOM extract helpers (~1,100 of its 1,531 LOC).
- `manifest.json`: `host_permissions: ["https://www.linkedin.com/*"]` and the
  `content_scripts` entry. Name → de-LinkedIn ("Pipeline Tracker — drag to capture").

### Auth model

Unchanged from spec 015: JWT + binding token via the side-panel binding handshake. No
new env vars, no new Doppler secrets, no webhook-secret changes.

---

## Implementation Phases

### Phase 0 — Spike (½ day, throwaway)

Drop-zone test inside *this* extension's side panel logging
`dataTransfer.getData('text/html')` on `drop` and `clipboardData` on `paste`. Confirm a
LinkedIn selection lands with hrefs intact. **Gate:** if the side-panel surface does not
receive drops, fall back to paste-primary + Phase-4 in-page overlay before proceeding.

### Phase 1 — Capture surface + heuristic, no AI (~1.5 days)

- **What changes:** new `sidepanel/capture-section.ts` — a drop zone + paste zone that
  reads `text/html`/`text/plain`, runs the D-016-2 heuristic (`DOMParser` + reused
  `score-capture` heuristics), and prefills an editable card built from
  `editable-fields.ts`, plus the D-016-3 **Stage dropdown**.
- `page_url`: best-effort from `chrome.tabs.query({ active: true, lastFocusedWindow: true })`
  using **`activeTab`** (auto-granted when the user opens the side panel via the toolbar
  icon) — **not** the broad `tabs` permission, which exposes all-tab history and adds Web
  Store scrutiny + a re-prompt if later removed (review S-6). If `activeTab` can't reach
  it from the panel context, drop `page_url` rather than escalate the permission.
- **Save** → `enqueueManualCapture(...)` (decision 1) — always `setOutboxAndHistory(...)`, fresh
  `history_id`, `date` = today, `event_type` from the dropdown, `user_reviewed: true`,
  `scrape_confidence: 'high'`, `needs_review: false`, `api_key: ''`. Catches quota / full-outbox and
  shows an inline error, keeping the card populated (decision 2).
- **Frontend changes:** mount `capture-section` at the top of `sidepanel.ts`.
- **Tests:** heuristic extraction (fragment → fields), `heuristicConfidence()` high/low,
  dropdown→event_type mapping, empty/`text/plain`-only fragment, `enqueueManualCapture` invariant
  (exact flags + `recovered_html` absent), save quota/full-outbox → inline error + card retained,
  fragment-cap truncation. (vitest, extension suite.)

### Phase 2 — AI extraction + stage suggestion (~1 day)

- **What changes:** generalize `recover.ts` → `extractContact()` per D-016-4 (generic
  prompt, `suggested_event_type` in schema, de-anchored URL rule). Wire the capture flow:
  heuristic first; if low-confidence (or user clicks "Extract with AI"), **lock the card**
  (decision 4), call `extractContact()`, prefill card on resolve/timeout, unlock; default the Stage
  dropdown to `suggested_event_type`. **Do not persist `recovered_html`** — the save path stays on
  `setOutboxAndHistory` (decision 3). Update `recover.ts`'s LinkedIn-anchored reconciliation comment
  (lines ~119-123) when generalizing.
- AI-unavailable path: heuristic values stand (never-throws invariant preserved).
- **Tests (mock `LanguageModel`):** generic extraction, `suggested_event_type` defaults
  the dropdown, invalid `suggested_event_type` coerced to null (S-1), AI-fail → heuristic fallback,
  model-unavailable → editable card still saveable, **card locked during in-flight extraction**
  (edit attempts blocked; late AI write does not clobber), `recovered_html` never persisted.

### Phase 3 — Remove LinkedIn scraping + de-LinkedIn (~1 day)

- **What changes:** delete Cards + `extract()`, drop the `linkedin-tracker` dep, strip
  `content.ts` scraping flows (keep only any still-needed send/error plumbing — most of
  the file goes). `manifest.json`: remove `host_permissions` + `content_scripts`; rename.
- Relabel UI `linkedin_url` → "Profile / page URL" (wire field name unchanged).
- **Generalize URL rendering (review S-2):** `isSafeLinkedInUrl()` (sidepanel.ts:98)
  hard-checks `hostname === linkedin.com`, so non-LinkedIn captures render as unclickable
  text. Rename → `isSafeProfileUrl()` and allow any `https:` URL (keep the XSS-safe
  protocol check). Coordinate with the field relabel above.
- **Keep `renderReviewSection` mounted** — it's reused for the editable-fields card. It self-empties
  for manual captures (all `user_reviewed:true`). **Orphan risk accepted** (decision 7): a user
  upgrading from the scraper build with low-confidence rows still in the outbox should sync/clear
  first; no migration code ships. Document this in the release note.
- **Tests:** remove dead scraper suites; update build/manifest tests; confirm extension
  loads with no host permissions and the side panel captures end-to-end.

### Phase 4 — Fast-follow (parked)

- In-page drop overlay (content script, `<all_urls>`) **only if** Phase 0 shows
  drag-into-panel friction — otherwise never built.
- Multi-contact split (one selection → several cards).
- Optional `linkedin_url` → `profile_url` wire rename (coordinated with `tracker-import`).

---

## Edge Cases & Risk

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Side-panel `drop` doesn't fire in some Chrome build | L | H | Phase-0 spike gates it; **paste is always an equivalent input**; Phase-4 overlay as last resort |
| Fragment has only `text/plain` (no `text/html`) | M | M | Heuristic + AI both accept plain text; card stays editable |
| Built-in AI unavailable / not downloaded | M | M | Heuristic prefills; card fully editable; settings already expose model download |
| Wrong AI stage suggestion | M | L | Dropdown is user-overridable; suggestion is only a default |
| `page_url` unknown from side panel | M | L | Best-effort `chrome.tabs` active tab; not used for dedup |
| Duplicate capture (same person dropped twice) | M | L | Server dedup (URL-primary, name-fallback) already handles; optional client "seen" hint later |
| Selection spans multiple people | M | L | MVP extracts primary contact; multi-split is Phase 4 (non-goal) |
| Hostile markup in dropped HTML | L | M | All fields rendered via `value`/`textContent` (never `innerHTML`) — existing `editable-fields` invariant |
| Web Store data-use review | L | M | No host permissions; capture only on explicit user action; on-device AI — strengthens Limited-Use story |

---

## Relationship to spec 015

| 015 element | 016 effect |
|---|---|
| Unified external build, binding auth | **Base** — 016 builds on it |
| `tracker-import` + `pipeline`/`jobsearch` state machines | **Unchanged** — same wire `PipelineEvent` |
| `BUILD_TARGET` split removal (commit C7) | Done; 016 keeps single build |
| `scrape_confidence` / `needs_review` (A5) | Repurposed: card editor *is* review; still emitted, never holds rows back (D-016-5) |
| Part-B side-panel review UI (B2) | Reused as the **capture card editor** |
| AI fallback `recover()` (spec 013) | **Promoted to primary** + generalized (D-016-4) |

---

## Acceptance Criteria

- [ ] Phase-0 spike confirms side-panel `drop` and records the outcome (drop-works vs
      paste-primary) in a committed note/ADR or `capture-section.ts` comment (review N-2)
- [ ] Saved manual captures go through `enqueueManualCapture()` and carry `api_key: ''`,
      `scrape_confidence: 'high'`, `needs_review: false`, `user_reviewed: true`, a dropdown-set
      `event_type`, and **no `recovered_html`**; they appear in the unsynced list (not the held-back
      review queue) and sync via sync-pull
- [ ] A Save that hits storage quota / full outbox shows an inline panel error and **retains the
      card's values** (no silent data loss)
- [ ] The capture card is locked (inputs + Extract button disabled) while an extraction is in
      flight; a late AI result never overwrites a user edit
- [ ] `heuristicConfidence()` returns `'high'` for a plausible name + non-empty `https:` URL and
      `'low'` otherwise (independent of host)
- [ ] `extractContact()` validates `suggested_event_type` against the `EventType` enum and
      coerces unknown values to `null`; it never throws (D-AI-1)
- [ ] Non-LinkedIn `https:` profile URLs render as clickable links in the unsynced list
- [ ] `page_url` uses `activeTab` (or is dropped) — `manifest.json` does **not** request
      the broad `tabs` permission
- [ ] Dragging a selected element from any site into the side panel prefills a card with
      name / title / profile URL
- [ ] Pasting the same selection produces an identical prefilled card
- [ ] On-device AI fills/repairs fields when the heuristic is low-confidence, and never
      throws (D-AI-1 preserved); AI-unavailable still yields an editable, saveable card
- [ ] Stage dropdown maps to the correct wire `event_type`; AI `suggested_event_type`
      sets the default and is user-overridable
- [ ] Saving enqueues a `PipelineEvent` byte-compatible with `tracker-import`, verified in this
      repo's CI against a **committed wire-shape oracle fixture** (the exact field set
      `tracker-import` consumes). Cross-repo verification of the spec-015 `pipeline`/`jobsearch`
      state machines is out of band (those live in the `careersystems` repo)
- [ ] LinkedIn Cards, `extract()`, and the `linkedin-tracker` dependency are deleted
- [ ] `manifest.json` declares **no `host_permissions`** and **no `content_scripts`**;
      the unpacked extension loads and captures end-to-end
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm format`, `pnpm lint` all pass
- [ ] No hardcoded secrets; no `unknown` outside catch
- [ ] ADR filed in `docs/adr/` for "manual drag/paste capture replaces DOM scraping;
      `recover()` promoted to primary `extractContact()`"

---

## Open questions

1. **Stage granularity** — three `event_type` values cover both layouts today. Does the
   internal `pipeline` user want the dropdown to also expose Branch-taken stages directly,
   or keep relying on server-side `message_text` phrase classification? (MVP: keep server
   classification; dropdown only sets `event_type`.)
2. **Multi-contact selection** — confirm MVP extracts only the primary contact (defer
   splitting to Phase 4).
3. ~~**`tabs` permission**~~ — **Resolved:** use `activeTab`, or drop `page_url`; never
   request the broad `tabs` permission (review S-6).
4. **Wire rename** — keep `linkedin_url` field name indefinitely, or schedule the
   `profile_url` rename with a coordinated `tracker-import` change?
