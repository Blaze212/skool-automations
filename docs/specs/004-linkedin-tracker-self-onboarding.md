# LinkedIn Tracker Self-Onboarding

**Status:** Ready for implementation
**Owner:** Barton Holdridge
**Last updated:** 2026-05-14
**Review mode:** HOLD SCOPE (product review 2026-05-14; eng review 2026-05-14)

## Objective

Eliminate the manual DB-insert step required to provision a new LinkedIn Tracker client. A new "Tracker" page in the CareerSystems app walks clients through setup step by step — Google Sheet URL, API key generation, service account sharing, and extension install. The extension popup becomes a thin configuration surface: paste API key, test connection, done.

Future iterations of the Tracker page can host the outreach log inline (read from the stored sheet_id), making it a live dashboard without any additional backend work.

## Non-goals

- Automatically sharing the client's Google Sheet with the service account (requires the client's Google OAuth token — sharing a single email address once is low friction)
- Self-service key revocation or rotation
- Multiple API keys per CareerSystems user
- Onboarding clients who do not have a CareerSystems account (manual DB insert by Barton remains available as a fallback)
- Outreach log display on the Tracker page (deferred — plumbing is in place once the page ships)

## Business Rationale

Currently Barton must manually generate a UUID, insert a DB row, and hand the key to the client out-of-band for every new engagement. The Tracker page makes onboarding self-service and gives clients a clear, guided setup experience. The CareerSystems Supabase project is shared with skool-automations, so JWT validation requires no cross-project auth plumbing — both apps share the same Supabase instance and the same JWT signing secret, making `auth.getUser(jwt)` work across both frontends.

**This plan resolves TODOS.md items:** "CareerSystems app integration — link extensions to user profiles" (P2) and "Self-service api_key creation for linkedin-tracker" (P3). Mark both complete when this ships.

---

## Architecture

### End-to-end onboarding flow

1. Client creates a CareerSystems account (or logs in)
2. Client navigates to `/tracker` in the CareerSystems app (`cmcareersystems.com`)
3. **Step 1 — Connect your sheet:** Client pastes their Google Sheet URL → page parses sheet_id → calls `linkedin-tracker-provision` with the user's JWT + parsed sheet_id → API key generated and displayed
4. **Step 2 — Share your sheet:** Page shows the service account email with a "Share your sheet →" link that deep-links to the sheet's sharing dialog; client grants Editor access
5. **Step 3 — Install the extension:** Page shows a download link and brief install instructions
6. **Step 4 — Configure the extension:** Page shows the API key with a "Copy" button and instructions to paste it into the extension popup
7. Client opens the extension popup, pastes the API key, clicks **Save**
8. Client clicks **Test connection** in the popup → synthetic `TrackerEvent` POSTed to `linkedin-tracker-webhook` via `chrome.runtime.sendMessage` → canary row appears in sheet → "Connection verified ✓"

### New edge function: `linkedin-tracker-provision`

- **Auth:** `Authorization: Bearer <supabase-jwt>` (CareerSystems user JWT). Validated by calling `createAdminClient().auth.getUser(jwtToken)` after extracting the token from the header. On `error` from `getUser` where the error indicates an auth service failure (not just invalid token), throw `InternalServiceException`; on invalid/expired token or null user, throw `AccessDeniedException`.
- **CORS:** `Access-Control-Allow-Origin: https://app.cmcareersystems.com`. Handle `OPTIONS` preflight. The provision endpoint is called from the CareerSystems web app (not the extension), so CORS must be scoped to the app origin.
- **GET request:** Authenticated user with an existing row → 200 `{ api_key, sheet_id, service_account_email }`. No row → 404. This is the re-visit path: the Tracker page calls GET on load to check for an existing provisioned state.
- **POST request:** `{ sheet_id: string }` — sheet ID parsed from the URL the client provides on the Tracker page.
  - Validate: `sheet_id` present, non-empty, and matches `/^[a-zA-Z0-9_-]{10,}$/`; throw `ValidationException` if not.
  - Call `db.rpc('provision_linkedin_tracker', { p_user_id, p_sheet_id })` (PostgreSQL function defined in the Phase 1 migration). The function uses `INSERT ... ON CONFLICT (user_id) DO UPDATE SET sheet_id = EXCLUDED.sheet_id RETURNING api_key, sheet_id` — `api_key` is NOT in the UPDATE SET, so it is preserved on re-provision. Do NOT use the Supabase JS `.upsert()` API here; it cannot express "update only `sheet_id`" and would silently rotate `api_key` on conflict.
  - Read `GOOGLE_SERVICE_ACCOUNT_EMAIL` from env; throw `InternalServiceException` if unset.
  - Return `{ api_key, sheet_id, service_account_email }`.
- **`verify_jwt`:** `false` in `config.toml` (project convention; auth handled in-function)
- **No `X-Webhook-Secret`:** user-facing endpoint; auth is the Bearer JWT
- **Logging:** Use `logger.child({ fn: 'linkedin-tracker-provision' })`. Log at entry (`user_id`, `method`), on POST success (new user vs. sheet updated vs. unchanged), on GET hit/miss. Never log full `api_key` — log only prefix.

### Schema change

Add `user_id uuid` to `internal_cs.linkedin_tracker_clients`:
- Nullable — existing manually-provisioned rows have no `user_id`
- Unique constraint on `user_id` — one API key per CareerSystems user
- PostgreSQL allows multiple NULL values in a UNIQUE constraint (NULL != NULL) — manually-provisioned rows coexist correctly

### CareerSystems Tracker page (`/tracker`)

**Repo:** `careersystems` (separate from `skool-automations`). Lives in the CareerSystems React app at `app.cmcareersystems.com`.

A stepped setup UI in the CareerSystems React app. Each step has a clear completion state; completed steps collapse to a summary with a checkmark.

| Step | Content | Done state |
|------|---------|------------|
| 1 — Connect your sheet | Google Sheet URL `<input>` + **Activate** button | Sheet URL accepted, API key returned |
| 2 — Share your sheet | Service account email + **Share your sheet →** link (opens sheet sharing dialog) | Manual — "Mark as done" checkbox or proceed button |
| 3 — Install the extension | Download link + one-line install instructions | Manual — "I've installed it" button |
| 4 — Configure the extension | API key displayed with **Copy** button + instructions | Manual — "I've pasted my key" button |

**Step 1 — Activate button:** Disabled while the POST to `linkedin-tracker-provision` is in-flight to prevent double-submission.

**Step 2 — Share link URL:** `https://docs.google.com/spreadsheets/d/<sheet_id>/edit#sharing` — this opens the sheet's sharing dialog directly.

**Step 1 — Sheet URL parsing (client-side):** Parse with `/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/`. Show inline error before calling the endpoint if the URL doesn't match. The parse extracts the ID from all common Google Sheet URL variants (including `?usp=sharing` and `#gid=0` suffixes).

**Copy button fallback:** If the Clipboard API is unavailable (e.g., HTTP in local dev), fall back to selecting the API key text so the user can copy manually.

**Re-visiting the page when already provisioned:** On mount, call `GET /linkedin-tracker-provision` with the Supabase session JWT. 200 → pre-fill the sheet URL input and show all steps in their done state. 404 → first-time view (empty Step 1). If the session has expired, redirect to login with return URL `/tracker`.

After all four steps: "You're all set. The extension will log your LinkedIn outreach automatically." No further action needed from the Tracker page — test connection happens in the plugin.

Future iteration: add a Step 5 that displays the Outreach Log table (Sheets API read against the stored sheet_id).

### Extension popup changes

The popup becomes simpler — sheet URL and service account email are no longer needed here.

**Setup mode** (no `api_key` in storage):
- Short message: "Get your API key at app.cmcareersystems.com/tracker" with a clickable link
- API key input + **Save** button
- `<details>` "Manual setup" for power users / Barton (same as today, just de-emphasised)

**Configured mode** (has `api_key`):
- Existing status display (Configured, Last logged, Last error)
- **Test connection** button
- **Reset** button — clears `api_key` from storage and returns to setup mode
- Debug mode toggle

New `STORAGE_KEYS` entry: none required. Sheet ID is stored in the DB, not locally — the webhook looks it up by api_key.

**Test connection:** popup constructs a synthetic `TrackerEvent` (name: `"Test Entry"`, title: `""`, company: `""`, profile_url: `""`, page_url: `""`, message_type: `"Direct Message"`, message_text: `"Test row from LinkedIn Tracker setup — you can delete this."`, date: today, status: `"Sent"`, api_key: from storage) and sends it via `chrome.runtime.sendMessage`. Background processes it identically to any other event and uses `sendResponse` to return `{ ok: true }` or `{ ok: false, message: string }`. Popup shows "Connection verified ✓" on success; descriptive error on failure.

Background listener must return `true` from the `onMessage` listener callback to keep the message channel open for the async `sendResponse`.

### New env vars

| Var | Purpose |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | `client_email` from `GOOGLE_SERVICE_ACCOUNT_JSON`; returned by the provision endpoint so the Tracker page can display it |

Not a new secret — extracted from the existing `GOOGLE_SERVICE_ACCOUNT_JSON` and stored separately in Doppler as a plain string.

**⚠️ Deployment prerequisite:** `GOOGLE_SERVICE_ACCOUNT_EMAIL` **must be added to Doppler before Phase 2 is deployed.** If Phase 2 deploys without it, every provision call returns 500.

---

## Implementation Phases

### Phase 1 — Schema migration

- Add `user_id uuid` column (nullable) to `internal_cs.linkedin_tracker_clients`
- Add `UNIQUE (user_id)` constraint
- Migration: `YYYYMMDDHHMMSS_internal_cs_linkedin_tracker_user_id.sql`
- Add PostgreSQL function `internal_cs.provision_linkedin_tracker(p_user_id uuid, p_sheet_id text)` to the same migration — this is the atomic upsert the edge function will call via `db.rpc()`. The Supabase JS `.upsert()` API cannot express "update only `sheet_id`, preserve `api_key`" — it would overwrite `api_key` on conflict. The function must be at the DB layer:

```sql
CREATE OR REPLACE FUNCTION internal_cs.provision_linkedin_tracker(
  p_user_id uuid,
  p_sheet_id text
) RETURNS TABLE (api_key text, sheet_id text) LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  INSERT INTO internal_cs.linkedin_tracker_clients (user_id, sheet_id, api_key)
  VALUES (p_user_id, p_sheet_id, gen_random_uuid()::text)
  ON CONFLICT (user_id) DO UPDATE SET sheet_id = EXCLUDED.sheet_id
  RETURNING linkedin_tracker_clients.api_key, linkedin_tracker_clients.sheet_id;
END;
$$;
```

**Done when:** `pnpm migrate:local` succeeds; existing rows unaffected; `user_id` nullable with unique constraint; `internal_cs.provision_linkedin_tracker` callable in local DB; `pnpm typecheck` passes.

---

### Phase 2 — `linkedin-tracker-provision` edge function

- Two-file layout: `index.ts` + `linkedin-tracker-provision.ts`
- CORS: `Access-Control-Allow-Origin: https://app.cmcareersystems.com`. Handle `OPTIONS` preflight.
- Validate `Authorization: Bearer <jwt>` header; throw `AccessDeniedException` if absent
- Extract user from JWT via `createAdminClient().auth.getUser(jwtToken)`; distinguish auth service failure (→ `InternalServiceException`) from invalid/null user (→ `AccessDeniedException`)
- **GET path:** Select by `user_id`; return 200 `{ api_key, sheet_id, service_account_email }` if found; throw `ResourceNotFoundException` if not. Read `GOOGLE_SERVICE_ACCOUNT_EMAIL` from env (required for the response); throw `InternalServiceException` if unset.
- **POST path:** Parse `sheet_id` from body; throw `ValidationException` if missing, empty, or fails `/^[a-zA-Z0-9_-]{10,}$/`
- Call `db.rpc('provision_linkedin_tracker', { p_user_id: userId, p_sheet_id: sheetId })` (the Phase 1 PostgreSQL function). It atomically inserts a new row (generating `api_key` via `gen_random_uuid()`) or updates only `sheet_id` on conflict, preserving the existing `api_key`. Do NOT use `.upsert()` — it would overwrite `api_key` on conflict.
- Read `GOOGLE_SERVICE_ACCOUNT_EMAIL` from env; throw `InternalServiceException` if unset
- Return `{ api_key, sheet_id, service_account_email }`
- Register in `supabase/config.toml` with `verify_jwt = false`
- Add `GOOGLE_SERVICE_ACCOUNT_EMAIL` to Doppler **before deploying this phase**
- Tests in `tests/unit/functions/linkedin-tracker-provision.test.ts`:
  - OPTIONS preflight → 204
  - Valid JWT + new user → 200, `api_key` generated, row inserted
  - Valid JWT + existing user, same sheet_id → 200, same `api_key` returned
  - Valid JWT + existing user, new sheet_id → 200, same `api_key`, `sheet_id` updated
  - Missing Authorization header → 403
  - Invalid JWT → 403
  - Auth service failure (`getUser` returns an error, not a null user) → 500
  - Missing `sheet_id` → 400
  - Invalid `sheet_id` format (too short / invalid chars) → 400
  - DB upsert throws → 500
  - `GOOGLE_SERVICE_ACCOUNT_EMAIL` not set → 500
  - GET: authenticated user with existing row → 200 `{ api_key, sheet_id, service_account_email }`
  - GET: authenticated user no row → 404
  - GET: no Authorization header → 403
  - GET: invalid JWT → 403
  - GET: `GOOGLE_SERVICE_ACCOUNT_EMAIL` not set → 500

**Done when:** `curl -X POST .../linkedin-tracker-provision -H "Authorization: Bearer <jwt>" -d '{"sheet_id":"..."}'` returns `{ api_key, sheet_id, service_account_email }` locally. `curl -X GET` with same JWT returns same values.

---

### Phase 3 — CareerSystems Tracker page

**Repo:** `careersystems` (separate from `skool-automations`)

- New route `/tracker` in the CareerSystems React app
- Requires auth (redirect to login if unauthenticated; return to `/tracker` after)
- **On mount:** call `GET /linkedin-tracker-provision` with Supabase session JWT. 200 → pre-fill sheet URL + show all steps completed. 404 → first-time view (empty Step 1). Session expired → redirect to login.
- **Step 1:** Sheet URL input → parse sheet_id client-side (regex `/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/`) → show inline error if parse fails → POST to `linkedin-tracker-provision` with Supabase session JWT → **disable Activate button while in-flight** → store returned `api_key` and `service_account_email` in component state
- **Step 2:** Display `service_account_email` + "Share your sheet →" link (`https://docs.google.com/spreadsheets/d/<sheet_id>/edit#sharing`) + manual confirm button
- **Step 3:** Extension download link + install instructions + manual confirm button
- **Step 4:** Display `api_key` with copy-to-clipboard button (fallback: select text if Clipboard API unavailable) + instructions + manual confirm button
- **Completion state:** all steps confirmed → "You're all set. The extension will log your LinkedIn outreach automatically."

**Done when:** A new CareerSystems user can complete all four steps without any manual action from Barton. Barton can re-visit the page and see his existing API key.

---

### Phase 4 — Extension popup UX

- **`background.ts`:** Add a per-request 10s `AbortController` timeout inside `handleMessage` — create the controller inside the function body on each call, never at module scope (a shared controller would abort concurrent fetches when any single one times out). Applies to all webhook POSTs, including test. Update `chrome.runtime.onMessage.addListener` callback to use `sendResponse` and return `true` (required for async response). Return `{ ok: boolean, message?: string }` from `handleMessage`.
- **Popup HTML:** Add setup-mode / configured-mode layout. Setup mode: Tracker link + API key input + Save button + `<details>` manual setup. Configured mode: status display + Test connection button + Reset button + debug toggle.
- **Popup TS:** On load, check `STORAGE_KEYS.API_KEY` in storage. No key → setup mode. Has key → configured mode. Test connection: construct synthetic `TrackerEvent` with canary values, call `chrome.runtime.sendMessage`, await response, show "Connection verified ✓" or descriptive error. Reset: clear `STORAGE_KEYS.API_KEY` from storage, switch to setup mode. Test connection button and Activate button both disabled while in-flight.
- Tests in `tests/unit/extension/popup.test.ts` (existing file — add tests; do NOT replace the 10 existing tests):
  - Setup mode shown when no `api_key` in storage; Tracker link present
  - Configured mode shown when `api_key` present
  - Test connection: success → "Connection verified ✓" shown
  - Test connection: 403 → "Sheet not shared" message shown
  - Test connection: 500 → "Connection failed. Check your key." shown
  - Test connection: AbortError (timeout) → "Connection timed out" shown
  - Reset clears `api_key` and returns to setup mode
  - Manual setup `<details>` collapsed by default; save still works when expanded
  - Test connection button disabled while test in-flight
- Tests in `tests/unit/extension/background.test.ts` (existing file — add tests):
  - `handleMessage` returns `{ ok: true }` on 200 response
  - `handleMessage` returns `{ ok: false, message: "Connection timed out" }` when AbortController fires after 10s

**Done when:** Fresh popup shows the Tracker link. Configured popup shows Test connection and Reset. End-to-end smoke test: complete the Tracker page flow → paste key into plugin → click Test → canary row in sheet.

---

## Edge Cases & Risk

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| User not logged in when landing on `/tracker` | H | L | Standard Supabase auth guard; redirect to login with return URL |
| Two tabs calling provision simultaneously for the same user | L | L | `ON CONFLICT DO UPDATE` is atomic; Activate button disabled while in-flight |
| Manually-provisioned rows (no `user_id`) coexist with self-provisioned row | L | M | `user_id = NULL` rows are not matched by the unique constraint; user gets a new api_key separate from any manually-created one. Acceptable in V1. |
| Client pastes a Sheet URL with wrong format | M | L | Inline parse on the Tracker page shows error before calling the endpoint; endpoint also validates format |
| Canary test row appears in client's sheet | M | L | Row clearly labelled "Test row — you can delete this"; noted in setup instructions |
| `service_account_email` absent from env | L | H | `InternalServiceException` thrown at provision time; add to Doppler before deploying Phase 2 |
| Client shares sheet but later revokes access | L | M | Next webhook POST fails; popup shows "Last POST failed"; client re-shares |
| Webhook POST hangs (no response) | L | L | 10s AbortController timeout in `handleMessage` shows "Connection timed out" in popup |
| Session expires mid-setup on Tracker page | L | L | GET on mount detects expired session; redirect to login |

---

## Acceptance Criteria

- [ ] Migration applies locally; existing rows unaffected; `user_id` nullable with unique constraint; `internal_cs.provision_linkedin_tracker(p_user_id, p_sheet_id)` callable in local DB
- [ ] `linkedin-tracker-provision` GET: authenticated user with row → 200 `{ api_key, sheet_id, service_account_email }`; no row → 404; no/invalid JWT → 403
- [ ] `linkedin-tracker-provision` POST: valid JWT + new user → 200 `{ api_key, sheet_id, service_account_email }`; existing user → same `api_key`; invalid/missing JWT → 403; missing/invalid `sheet_id` → 400; missing env var → 500
- [ ] Tracker page: unauthenticated users redirected to login with return URL
- [ ] Tracker page: completing all four steps requires no action from Barton
- [ ] Tracker page: re-visiting when already provisioned shows existing API key and sheet URL (via GET on mount)
- [ ] Tracker page: Activate button disabled while POST in-flight
- [ ] Tracker page: Step 2 share link opens `https://docs.google.com/spreadsheets/d/<sheet_id>/edit#sharing`
- [ ] Popup: setup mode shows Tracker link (`app.cmcareersystems.com/tracker`); configured mode shows Test connection and Reset buttons
- [ ] Test connection POSTs synthetic `TrackerEvent` via `chrome.runtime.sendMessage`; canary row appears in sheet on success; 403 surfaces as "Sheet not shared"; network/timeout surfaces as descriptive error
- [ ] Reset clears `api_key` and returns popup to setup mode
- [ ] Background `handleMessage` has 10s AbortController timeout on all webhook POSTs
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm format` pass
- [ ] `GOOGLE_SERVICE_ACCOUNT_EMAIL` added to Doppler before Phase 2 deployed; returned by provision endpoint (not hardcoded anywhere)
- [ ] `linkedin-tracker-provision` in `config.toml` with `verify_jwt = false`
- [ ] All new unit tests pass; no existing tests broken
