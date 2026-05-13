# TODOs

Tracked improvements deferred from active implementation work.

---

## LinkedIn Activity Tracker

### [P2] Client setup runbook for linkedin-tracker

**What:** A short runbook at `docs/runbooks/linkedin-tracker-client-setup.md` covering the two manual steps required when onboarding a new client: (1) share the client's Google Sheet with the service account email address, (2) insert a row into `internal_cs.linkedin_tracker_clients` with a generated UUID `api_key`, the Sheet ID, and a label.

**Why:** These steps are easy to forget, especially the SA sharing step, which causes a silent 500 error from the Sheets API. A runbook prevents this.

**Effort:** S  
**Depends on:** Phase 4 of linkedin-tracker shipped

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

### [P3] Self-service api_key creation for linkedin-tracker

**What:** A lightweight mechanism for creating new `linkedin_tracker_clients` rows without manual DB access — either a small admin Edge Function or a Supabase Studio script.

**Why:** Manual DB insertion works fine for 2-3 clients. At 10+ clients it becomes an operational burden and error-prone.

**Effort:** M  
**Context:** The `linkedin_tracker_clients` table has a simple schema (`api_key`, `sheet_id`, `label`). A POST endpoint protected by a service-role key or admin secret would be sufficient for V1.5 self-service.  
**Depends on:** Phase 4 of linkedin-tracker shipped; enough clients to justify the overhead
