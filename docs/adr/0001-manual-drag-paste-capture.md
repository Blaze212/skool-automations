# ADR 0001 — Manual drag/paste capture replaces DOM scraping; `recover()` promoted to primary `extractContact()`

- **Status:** Accepted
- **Date:** 2026-06-05
- **Spec:** [016-manual-capture-pivot](../specs/016-manual-capture-pivot.md)
- **Supersedes the input edge of:** spec 013 (LinkedIn AI fallback), spec 011/015 LinkedIn Card scraping

## Context

The Pipeline Tracker extension acquired contacts by click-scraping the LinkedIn
DOM (a content script + a library of `Card` extractors + an `extract()`
orchestrator + an on-device AI **fallback**, `recover()`, that repaired
low-confidence scrapes). That input edge had three structural problems:

1. It required `host_permissions: ["https://www.linkedin.com/*"]` and a
   `content_scripts` entry — the two biggest blockers to a Chrome Web Store
   listing and the source of LinkedIn-ToS scraping risk.
2. It broke **silently** whenever LinkedIn shipped DOM changes.
3. It was LinkedIn-only — no other site could ever be captured.

The expensive downstream infrastructure (outbox/sync, binding handshake, badge,
CSV export, review/edit UI, on-device `LanguageModel`) is independent of *how*
fields are acquired, and the wire `PipelineEvent` contract the backend consumes
does not depend on the acquisition path.

## Decision

Replace automated scraping with **manual, site-agnostic capture**:

- The user drags a selected element from **any** web page into the side panel,
  or copies + pastes it. A `drop` / `paste` handler on a focusable drop zone
  reads the `text/html` / `text/plain` fragment. **No content script and no
  `host_permissions`** — the cleanest possible Web Store review surface.
- A site-agnostic **heuristic** (`capture-heuristic.ts`) prefills
  `{ name, title, linkedin_url, message_text }` instantly with no AI, and scores
  confidence (`heuristicConfidence`: plausible name + non-empty `https:` URL →
  `high`, else `low`).
- The spec-013 LinkedIn AI **fallback** `recover()` is generalized and promoted
  to the **primary** extractor `extractContact()` (de-LinkedIn prompt, no
  `linkedin.com` URL anchoring, a new validated `suggested_event_type`). It runs
  on-device when the heuristic is low-confidence or the user asks. Its
  never-throws invariant (D-AI-1) is preserved — any failure degrades to the
  heuristic, and the card is always editable, so nothing is ever dropped.
- The user reviews the prefilled card, pastes message text manually, and picks a
  **Stage** from a dropdown (AI suggests a default). Saving enqueues exactly the
  same wire `PipelineEvent` the backend already consumes, via the single typed
  `enqueueManualCapture()` helper that hard-codes the wire invariant
  (`scrape_confidence: 'high'`, `needs_review: false`, `user_reviewed: true`,
  `api_key: ''`, fresh `history_id`) and **never** persists `recovered_html`.

The card editor **is** the review step — every saved capture is `user_reviewed`
by construction, so manual captures flow straight to sync (never held back).

## Phase-0 spike outcome

The side-panel `drop` surface receives a populated `dataTransfer` with `text/html`
intact (re-confirmed inside this extension's panel; the user's
`drag-link-inspector` MVP demonstrated it first). Drag-into-panel is the primary
input; **paste is an always-available equivalent**. The Phase-4 in-page overlay
is therefore parked, not built.

## Consequences

- **Deleted (~scraper input edge):** `packages/scraping-core/src/cards/*`, the
  `extract()` orchestrator, `pipeline-tracker/src/content.ts`,
  `score-capture.ts` (+ tests), the `linkedin-tracker` relative-import
  dependency, and the manifest's `host_permissions` + `content_scripts`.
  Extension renamed → "Pipeline Tracker — drag to capture".
- **No backend changes.** `tracker-import` and the spec-015
  `pipeline`/`jobsearch` state machines consume the identical wire event. The
  wire field name `linkedin_url` is **kept** (UI label is now "Profile / page
  URL"); a `profile_url` rename is a deferred, coordinated follow-up.
- **`recovered_html` is dormant, not "the gift."** After the pivot nothing
  writes it (manual captures never carry it). The machinery is left in place;
  whether to strip it or repurpose it for an opt-in server-AI fallback is an open
  decision tracked in `TODOS.md` (repurposing would re-open the Limited-Use
  posture this pivot exists to protect).
- **`page_url`** is best-effort via the `activeTab` permission (auto-granted when
  the panel is opened from the toolbar icon) — **not** the broad `tabs`
  permission. Dropped to `''` if unavailable; not used for dedup.
- **Legacy orphan risk (accepted).** A user upgrading from the scraper build with
  low-confidence *scraped* rows still in the outbox (`needs_review &&
  !user_reviewed`) should **sync/clear before upgrading**; no migration code
  ships. `review-section.ts` stays mounted for this coexistence window and
  self-empties for manual captures.

## Alternatives considered

- **In-page drop overlay / content script (`<all_urls>`).** Rejected for the MVP
  — re-introduces a content script and host-permission scrutiny. Parked as a
  Phase-4 fast-follow only if drag-into-panel shows friction.
- **Server-side AI extraction.** Rejected — sending arbitrary cross-site HTML to
  the backend is the exact data-use the pivot avoids. The heuristic + always-
  editable card degrade gracefully when on-device AI is unavailable.
