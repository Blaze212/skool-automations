# TODOs

Tracked improvements deferred from active implementation work.

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
