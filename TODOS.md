# TODOs

Tracked improvements deferred from active implementation work.

---

## Pipeline Tracker

### [P2] Strip spec-016 prompt-tuning debug logs + sample-collection scaffolding

**What:** Remove the temporary debugging added during spec-016 prompt tuning before the next release: (1) the `[extractContact] AI input prompt` / `AI raw output` / EXIT `console.log`s in `packages/scraping-core/src/ai-fallback/extract-contact.ts`; (2) the `[Pipeline Tracker AI]` verbose tracing + `debugLogCaptureFragment` (the `DROP — raw fragment` / `DROP — LLM-bound content` logs) in `pipeline-tracker/src/sidepanel/sidepanel.ts`; (3) the `debugLogFragment` hook in `capture-section.ts`; (4) the TEMPORARY "a new drop always overwrites (no replace-confirm / no still-extracting block)" behavior in `capture-section.ts` — restore the state guards + `confirmReplace` when sample collection is done.

**Why:** These log full prompts, raw model output, and raw dragged HTML (incl. message bodies / PII) to the console on every capture, and the "overwrite without confirm" behavior is a sample-collection convenience, not the intended UX.

**Effort:** S  
**Depends on:** done collecting prompt-eval fixtures (drag-link-inspector harness)

---

## LinkedIn Activity Tracker

### [P3] Manual fallback runbook for linkedin-tracker client setup

**What:** A short runbook at `docs/runbooks/linkedin-tracker-manual-provision.md` covering the manual steps for provisioning a client who doesn't have a CareerSystems account (the self-onboarding path is unavailable to them): (1) insert a row into `internal_cs.linkedin_tracker_clients` with a generated UUID `api_key`, the Sheet ID, and a label, (2) share the client's Google Sheet with the service account email address, (3) hand the api_key to the client out-of-band.

**Why:** Self-onboarding (spec 004) handles the common case, but the manual fallback path still exists for non-CareerSystems clients. The SA sharing step is easy to forget and causes a silent 500 error from the Sheets API.

**Effort:** S  
**Depends on:** linkedin-tracker self-onboarding (spec 004) shipped — scope narrowed at that point from "standard onboarding" to "manual fallback only"

---

### [P2] Strip debug mode before Chrome Web Store submission

**What:** Before any Chrome Web Store submission, remove: (1) the debug mode toggle from `popup.html` and `popup.ts`, (2) the `debug` field from `TrackerEvent` and the content script payload logic, (3) the debug logging from the Edge Function.

**Why:** Sending container HTML to an external server will trigger Google's store review process even when opt-in. The debug mechanism is a dev tool for selector debugging, not a user feature.

**Effort:** S  
**Depends on:** Decision to submit to Web Store (blocked by $5 fee + review process)

---

### [P3] Connection request note text capture

**What:** When a connection request is sent _with_ a custom note, capture the note text in `message_text`. The note is in a separate `<textarea>` in the note composer, not the main `[contenteditable]`. Add selector targeting for this element in `content.ts` at the connection request handler.

**Why:** Currently `message_text` is always `""` for connection requests. The note text is valuable pipeline context.

**Effort:** S  
**Context:** A `TODO` comment is left in `content.ts` at the connection request handler. Start there. Deduplication and payload construction are already in place — only the textarea scrape is missing.  
**Depends on:** Phase 2 of linkedin-tracker shipped

---

### [P3] Company extraction from LinkedIn headline

**What:** Parse the `title` field (full LinkedIn headline string, e.g. "Fractional CTO | SaaS | B2B") to extract the company name and populate the `company` field in `TrackerEvent` and the COMPANY column in the Outreach Log sheet.

**Why:** The COMPANY column is currently always blank from the extension. Users fill it in manually when reviewing the log. Automating it removes a step.

**Effort:** S  
**Context:** The full headline is captured in `title`. A simple split on `|` or `at` covers most LinkedIn headline formats. Edge cases: no separator, multiple pipes, company listed first. Recommend doing this in the content script before building the payload.  
**Depends on:** Phase 2 of linkedin-tracker shipped

---

### [P2] CareerSystems app integration — link extensions to user profiles

**What:** When the LinkedIn tracker moves into the CareerSystems app (`/Users/barton/workspaces/careersystems/workspace`), replace the manual `api_key` model with app-profile-linked keys. Each CareerSystems user account would have an associated `api_key` (or OAuth-based auth) that ties their extension activity to their profile, enabling per-user dashboards, history, and management.

**Why:** The current flat `linkedin_tracker_clients` table with manually inserted rows works for a handful of fractional clients but doesn't scale to a multi-tenant product. Profile-linked keys enable self-service onboarding, audit trails, and per-user analytics.

**Effort:** L  
**Context:** The current `internal_cs.linkedin_tracker_clients` table (`api_key`, `sheet_id`, `label`) would need a `user_id` FK to the CareerSystems user table. The Chrome extension's popup would need a "Sign in with CareerSystems" flow (OAuth or magic link) instead of manual api_key entry. The Edge Function would validate against the user table rather than the tracker clients table.  
**Depends on:** LinkedIn tracker V1 shipped and stable; CareerSystems multi-tenant architecture in place

---

### [P2] Outreach Log inline on Tracker page (Step 5)

**What:** Add a Step 5 to the `/tracker` page that displays the client's Outreach Log table inline, read from the Google Sheet via the Sheets API using the stored `sheet_id`.

**Why:** Clients currently have to open their Google Sheet to review outreach history. An inline view on the Tracker page removes that friction and makes the page a live dashboard — without any schema changes.

**Effort:** M
**Context:** All plumbing is in place after the self-onboarding spec ships: `sheet_id` is stored in the DB, the Supabase session JWT is available on the Tracker page, and `createGoogleSheetsClient()` already handles auth. The new work is: a read method on the Sheets client (`getRows(sheet_id, range)`), a new GET endpoint (or extend provision), and the React table component. The data shape matches the existing `Outreach Log!B:M` range.
**Depends on:** Phase 3 of linkedin-tracker self-onboarding shipped

---

### [P2] Key rotation UI on Tracker page

**What:** A "Regenerate key" button on the `/tracker` page that generates a new `api_key` for the user's row and displays it with instructions to update the extension.

**Why:** If a client suspects their key is compromised, or if Barton needs to revoke access manually, there is currently no UI path — it requires a direct DB update. The Tracker page is the natural home for self-service rotation.

**Effort:** S
**Context:** The provision function already upserts the row on POST. Add a `force_rotate: true` flag to the POST body that generates a new `crypto.randomUUID()` for `api_key` instead of preserving the existing one (`ON CONFLICT ... DO UPDATE SET api_key = gen_random_uuid(), sheet_id = EXCLUDED.sheet_id`). The Tracker page calls POST with `force_rotate: true` and displays the new key.
**Depends on:** Phase 2 of linkedin-tracker self-onboarding shipped

---

### [P3] Self-service api_key creation for linkedin-tracker

**What:** A lightweight mechanism for creating new `linkedin_tracker_clients` rows without manual DB access — either a small admin Edge Function or a Supabase Studio script.

**Why:** Manual DB insertion works fine for 2-3 clients. At 10+ clients it becomes an operational burden and error-prone.

**Effort:** M  
**Context:** The `linkedin_tracker_clients` table has a simple schema (`api_key`, `sheet_id`, `label`). A POST endpoint protected by a service-role key or admin secret would be sufficient for V1.5 self-service.  
**Depends on:** Phase 4 of linkedin-tracker shipped; enough clients to justify the overhead

---

## Pipeline Tracker — Publishable (spec 010)

### [P2] bindingToken per-cycle rotation (publishable extension)

**What:** Rotate the extension's `bindingToken` on every successful `sync-ack` so a stolen token has at most a one-cycle blast radius. Mechanism: extension generates a new token, returns it in the `sync-ack` response, and the app PATCHes `/api/pipeline/bind-extension` to update the server-side copy before the next cycle.

**Why:** Spec 010 D-rev-14 documents `bindingToken` theft (via XSS on `app.cmcareersystems.com`, or a sibling browser extension with that host permission) as a residual risk. Once stolen, the token is a bearer credential for the user's full unsynced outbox until the user manually disconnects in the side panel. Rotation reduces the window to the time between two syncs.

**Effort:** M
**Context:** Spec 010 ships with a static post-bind token. v1.0 documents the theft path in the Web Store privacy posture. Rotation is the planned mitigation. Coordinate with the CareerSystems app team — `/api/pipeline/bind-extension` needs to accept a PATCH/rotate verb.
**Depends on:** Spec 010 v1.0 shipped + stable; app-team endpoint supports PATCH/rotate

---

### [P3] Ambient sync via chrome.alarms (publishable extension)

**What:** Add a `chrome.alarms`-driven background check that, when `app.cmcareersystems.com` is open in any tab, triggers a sync without the user clicking the side panel's Sync button.

**Why:** Spec 010 v1.0 sync is user-gestured only — a user who captures heavily but rarely opens the app sees the outbox grow indefinitely (uncapped per Issue 1 redesign). Ambient sync removes that friction at the cost of a Web Store "runs in the background" disclosure and the `alarms` permission.

**Effort:** S
**Context:** Spec 010 Open Q #3. Deliberately deferred from v1.0 to keep the Web Store permission disclosure minimal. Revisit after dogfooding signals — if users report "I forgot to sync for two weeks," do this.
**Depends on:** Spec 010 v1.0 shipped + dogfooding feedback on sync friction

---

### [P2] linkedin-tracker / pipeline-tracker convergence direction

**What:** Decide the long-term shape of LinkedIn-scraping inside the CareerSystems product. Three plausible end states: (a) `linkedin-tracker/` stays as the fractional-clients internal tool and `pipeline-tracker/` is the consumer Web Store product — permanently separate; (b) `linkedin-tracker/` retires and `pipeline-tracker/` (internal build) replaces it for fractional clients; (c) both merge into a single shared core with two manifest targets.

**Why:** Spec 010 D-rev-21 accepts "double-capture" when both extensions are installed in the same Chrome profile as a convergence-period compromise. That's not sustainable forever — users who install both will see duplicate rows in their backend (the app dedupes per D-rev-18, but the UX is confusing).

**Effort:** L (any convergence) or zero (if (a) is the answer)
**Context:** Spec 010 Open Q #5. The scraping cores are already close (linkedin-tracker uses ConnectionSearchCard/ProfilePageCard/MessengerPageCard; pipeline-tracker adds accept-invitation + chat-overlay + profile-page-accept). Once spec 010's prereq scraping-core spec lands, option (c) is much cheaper. Convergence is mostly a _product_ question, not engineering: does fractional-client scope diverge from consumer scope, or are they the same surface?
**Depends on:** Spec 010 v1.0 shipped; scraping-core extraction spec landed

---

## Pipeline Tracker — Manual Capture Pivot (spec 016)

### [P2] Decide recovered_html subsystem fate — strip vs. repurpose for server-AI fallback

**What:** After spec 016 deletes the LinkedIn scraper, the `recovered_html` subsystem (`setOutboxHistoryAndRecoveredHtml`, the whole `recoveredHtmlStore`, `RecoveredHtmlTooLargeError`, sync-pull's lazy attach, CSV's `ai-recovered` read, `wipe_unsynced`'s `removeAll`, `PipelineEvent.recovered_html`/`source`) has **no producer** — it's dormant, not dead-by-design. Decide between (a) **strip** it entirely, or (b) **repurpose** it as the carry channel for an opt-in **server-side AI fallback** for users whose on-device Gemini `LanguageModel` is unavailable.

**Why:** Keeps the codebase honest about dormant code, and captures the open question of whether to add a backend extraction fallback. The MVP left it in place (spec-016 review decision 5A) precisely to keep this option open.

**Pros:** Preserves a concrete future option without silently leaving a privacy-sensitive channel wired with no consumer.
**Cons:** Repurposing **reverses spec-016 Decision 3's Limited-Use posture** — sending arbitrary cross-site HTML fragments to the backend is the exact data-use the pivot exists to avoid. It would require an explicit **per-capture consent gate** ("send this fragment to our server to extract?") and a Web Store data-use re-disclosure.

**Context:** The heuristic runs with zero AI and the capture card is always editable, so "on-device AI unavailable" already degrades gracefully to _heuristic prefill + manual edit_ — capture is never blocked, only auto-fill quality drops. So server AI is a quality nicety, not a capture unblock. Let the beta produce on-device-AI reliability data before deciding.
**Effort:** S (strip) or M (server fallback + consent gate + disclosure)
**Depends on:** spec 016 shipped; beta on-device-AI reliability data

---

### [P3] Delete review-section.ts after legacy coexistence drains

**What:** `review-section.ts` (spec 015 B2 needs-review queue) goes dormant under spec 016 — it self-empties for manual captures (all `user_reviewed:true`). Once beta users have synced/cleared their legacy low-confidence _scraped_ rows, it is pure dead UI and can be deleted along with the `needs_review`-queue plumbing (`countPendingReview`, the review-badge branch, `markOutboxReviewed`/`reviewOutboxEntry` if no other caller remains).

**Why:** Removes dead UI and the misleading "reused as the capture editor" framing (spec 016 D-016-5). The actual reused piece is `editable-fields.ts`; the capture editor is the new `capture-section.ts`, and unsynced rows are already independently editable (commit `11e2f88`).

**Pros:** One fewer editing surface; smaller, clearer side panel.
**Cons:** Must confirm the legacy outbox is fully drained first or risk orphaning held-back rows (spec 016 Decision 7).
**Effort:** S
**Depends on:** spec 016 shipped; beta users confirmed to have drained legacy held-back rows

---

### [P3] Real scored eval harness for extractContact() before GA

**What:** Spec 016 ships with a small committed real-fragment fixture set + manual spot-check (review decision T1-A). Before graduating beyond the handful of beta users (Web Store / GA), stand up a scored eval suite (fixtures + rubric + pass threshold) for the now-**primary** on-device extractor, seeded from the T1-A fixtures.

**Why:** `extractContact()` produces every capture's prefill on arbitrary sites (promoted from spec-013 _fallback_ to _primary_). At GA scale, regressions in the generalized prompt or a Chrome model-version bump need an automated quality gate, not just mocks + spot-checks.

**Pros:** Catches prompt/model regressions automatically; protects the primary codepath at scale.
**Cons:** Real-model evals are slow/flaky in CI and need fixture curation; overkill while the card is always editable and the user base is tiny.
**Context:** Reuse the T1-A fragments (LinkedIn + 2-3 other sites) as the seed corpus.
**Effort:** M
**Depends on:** decision to pursue Web Store / GA
