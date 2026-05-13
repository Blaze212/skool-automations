# LinkedIn Activity Tracker

**Status:** Draft
**Owner:** Barton Holdridge
**Last updated:** 2026-05-13

## Objective

A Chrome extension that silently captures LinkedIn outreach activity (connection requests and direct messages) and logs each event to a Google Sheet via a Supabase Edge Function. The extension fires on the user's natural send actions — no manual data entry. Each client gets a unique API key that maps to their own Sheet, making the tool reusable across multiple fractional clients.

## Non-goals

- No deduplication against contacts already in the sheet (V1)
- No reply/response detection or status updates
- No contact bucketing or categorization
- No built-in dashboard or analytics view
- No Firefox or Safari support (Chrome/Chromium only, Manifest V3)
- No scraping of profile pages beyond what is visible in the send modal/conversation header at the moment of the send action

---

## Business Rationale

Barton's fractional clients need to track their LinkedIn outreach for pipeline management. Manual logging is error-prone and skipped under pressure. An invisible background logger that fires exactly when a message is sent removes the friction entirely and ensures the sheet stays accurate without behavioral change.

---

## Architecture

### Repository Layout

The extension lives at `linkedin-tracker/` in the repo root, compiled to `linkedin-tracker/dist/` which is the directory loaded into Chrome.

```
linkedin-tracker/
├── src/
│   ├── manifest.json          ← static; copied to dist as-is
│   ├── types.ts               ← TrackerEvent, DebugPayload, STORAGE_KEYS constants
│   ├── content.ts             ← injected into LinkedIn tabs
│   ├── background.ts          ← service worker; handles fetch POST
│   └── popup/
│       ├── popup.html         ← static; copied to dist as-is
│       └── popup.ts           ← popup logic
├── dist/                      ← build output; .gitignore'd
├── tsconfig.json
└── build.ts                   ← esbuild script (run via pnpm)
```

`package.json` gains a `build:extension` script: `tsx linkedin-tracker/build.ts`.

`esbuild` must be added as a devDependency (not currently in the repo's dependency graph).

### Build Pipeline

TypeScript is compiled to JS using **esbuild** (add as a dev dep). `build.ts` produces three output bundles:
- `dist/content.js` — IIFE bundle (no imports at runtime; LinkedIn CSP is strict)
- `dist/background.js` — ESM module (service worker in MV3 supports ESM)
- `dist/popup/popup.js` — IIFE bundle

`manifest.json` and `popup.html` are copied verbatim into `dist/`.

The `LINKEDIN_TRACKER_WEBHOOK_URL` env var is injected at build time via esbuild's `define` option in `build.ts` (using `process.env.LINKEDIN_TRACKER_WEBHOOK_URL`). This keeps the URL out of source control.

### Chrome Extension: Manifest V3

```json
{
  "manifest_version": 3,
  "name": "LinkedIn Activity Tracker",
  "version": "1.0.0",
  "permissions": ["storage"],
  "host_permissions": ["https://*.linkedin.com/*"],
  "content_scripts": [{
    "matches": ["https://www.linkedin.com/*"],
    "js": ["content.js"],
    "run_at": "document_idle"
  }],
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "action": {
    "default_popup": "popup/popup.html",
    "default_title": "LinkedIn Tracker"
  }
}
```

`host_permissions` is required (separate from `permissions` in MV3) for the content script to message the background service worker that then POSTs cross-origin.

### Shared Types (`types.ts`)

All storage key string literals live in a single `STORAGE_KEYS` constant to prevent drift between `background.ts`, `popup.ts`, and tests:

```typescript
export const STORAGE_KEYS = {
  API_KEY: 'api_key',
  DEBUG_MODE: 'debug_mode',
  LAST_LOGGED_AT: 'last_logged_at',
  LAST_ERROR: 'last_error',
} as const;

export interface TrackerEvent {
  api_key: string;
  date: string;
  name: string;
  title: string;
  company: string;
  message_type: 'Connection Request' | 'Direct Message';
  message_text: string;
  status: 'Sent';
  debug?: DebugPayload;
}

export interface DebugPayload {
  button_aria_label: string;
  button_text: string;
  container_html: string;  // capped at 10KB; may contain message thread content
  page_url: string;
}
```

### Content Script (`content.ts`)

Attaches `click` and `keydown` event listeners on `document.body` using event delegation. Selects elements by `aria-label` attributes — more stable than LinkedIn's obfuscated class names.

**Connection request sent:**
- Target: button with `aria-label="Send invite"` or `aria-label="Send without a note"`
- Scrapes from the modal: name from `[aria-label="Send invite to <name>"]` or the modal heading, headline from the subtitle element beneath it
- Fires `chrome.runtime.sendMessage` with payload tagged `message_type: "Connection Request"`

**Direct message sent (two triggers):**
- **Button click:** button with `aria-label="Send message"` in the messaging composer
- **Enter key:** `keydown` event on `document.body` where `e.key === 'Enter'` (without Shift) and the active element is the messaging composer's `[contenteditable]`
- Both triggers use the same handler: scrape name + headline from conversation header, capture message text from the composer's `[contenteditable]` element **before** the send fires (the field clears on send)
- Both fire `chrome.runtime.sendMessage` with payload tagged `message_type: "Direct Message"`
- The 500 ms deduplication guard prevents double-fire when both triggers activate in the same send action

**Deduplication guard:** a module-level `{ name: string; ts: number }` tuple. If a send event fires within 500 ms for the same `name`, the second is dropped.

**Error handling:** `chrome.runtime.sendMessage()` is wrapped in try/catch. If the service worker hasn't restarted yet (e.g., first send after browser start), `sendMessage` throws a Chrome runtime error. This is caught, logged via `console.warn`, and the event is silently dropped for that send.

**Selector fragility note:** LinkedIn periodically updates `aria-label` strings. The content script logs a warning to `console.warn` (not throw) if a required element is not found, so partial data still routes to background rather than silently failing.

**Debug mode:** When `debug_mode` is enabled in `chrome.storage.sync`, the content script attaches a `debug` field in two situations: (1) the clicked button has text "Send" but doesn't match any expected `aria-label`, or (2) a required scrape target (name, headline) could not be found. The `debug` field is omitted when `debug_mode` is off OR when the scrape succeeds cleanly — success never triggers debug capture.

The `container_html` field is capped at **10 000 characters** (substring truncation) before being attached. Note: the LinkedIn messaging container includes recent message thread content from both parties; this field may capture PII. Debug mode should only be enabled during active selector debugging, not in normal use.

```typescript
interface DebugPayload {
  button_aria_label: string;
  button_text: string;
  container_html: string;  // outerHTML of modal/conversation container, max 10KB
  page_url: string;
}
```

### Background Service Worker (`background.ts`)

Listens for `chrome.runtime.onMessage`. On receipt:
1. Reads `api_key` from `chrome.storage.sync`; if absent, logs `console.warn` and returns
2. POSTs to the configured Edge Function URL (baked in at build time)
3. On success (HTTP 200): writes `last_logged_at` to `chrome.storage.local`, clears `last_error`
4. On fetch throw (network error): logs `console.error`, writes `last_error` to `chrome.storage.local` with current timestamp
5. On non-200 response: logs `console.error` with status, writes `last_error` to `chrome.storage.local`

The fetch is wrapped in try/catch to handle network failures without crashing the service worker.

MV3 service workers are ephemeral; `chrome.storage.sync` is used (not in-memory state) so the API key is always available.

**Note on auth deviation:** This function does not use an `X-Webhook-Secret` header (project convention). Auth is the `api_key` field in the body — each client has a unique key. A global webhook secret baked into the extension binary would be shared across all clients and extractable from the bundle, providing no meaningful security over the per-client `api_key` lookup.

### Popup (`popup.ts`)

Single-screen UI:

| Element | Behavior |
|---|---|
| API key `<input>` | Pre-fills from `chrome.storage.sync` on open |
| Save button | Validates key is non-empty before writing; writes to `chrome.storage.sync`; shows "Saved ✓" briefly |
| Status indicator | Reads stored key; shows "Configured" (green) or "Not configured" (grey); empty string treated as not configured |
| Last logged timestamp | Stored in `chrome.storage.local` by background on each successful POST; displayed as "Last logged: May 13, 2026 at 2:34 PM" |
| Last error | If `last_error` is set in `chrome.storage.local`, shows red "Last POST failed: [date]" below the timestamp; cleared on next successful POST |
| Debug mode toggle | Checkbox; reads/writes `debug_mode` boolean in `chrome.storage.sync`; labelled "Debug mode (sends selector diagnostics on failure)" |

### POST Payload

```typescript
interface TrackerEvent {
  api_key: string;
  date: string;           // ISO 8601 date, e.g. "2026-05-13"
  name: string;
  title: string;          // full headline (may include company)
  company: string;        // empty string in V1; headline parsing deferred
  message_type: "Connection Request" | "Direct Message";
  message_text: string;   // empty string for connection requests without a note
  status: "Sent";
  debug?: {
    button_aria_label: string;
    button_text: string;
    container_html: string;  // outerHTML of modal or conversation container only, max 10KB
    page_url: string;
  };
}
```

`company` is left as `""` in V1. The full headline (e.g. "Fractional CTO | SaaS | B2B") is captured in `title` and can be parsed in the sheet downstream.

`debug` is only present when `debug_mode` is enabled in storage AND a selector failure occurred. The Edge Function logs the field but does not write it to the sheet.

### Edge Function: `linkedin-tracker-webhook`

Location: `supabase/functions/linkedin-tracker-webhook/`

Two-file layout per project convention:
- `index.ts` — thin entrypoint: `serve(handler)`
- `linkedin-tracker-webhook.ts` — all logic, exported as `handler()`

**Auth:** validates `api_key` from the request body against `internal_cs.linkedin_tracker_clients`. Returns `403` if unknown. No `X-Webhook-Secret` header — see auth deviation note above.

**Steps:**
1. Parse and validate request body (check required fields present); throw `ValidationException` on missing fields
2. Look up `sheet_id` from `internal_cs.linkedin_tracker_clients` by `api_key`; throw `AccessDeniedException` if not found
3. If `debug` field present, log it via pino child logger (not written to sheet)
4. Convert `date` from ISO 8601 (`2026-05-13`) to `M/D/YYYY` (`5/13/2026`) format for the row array
5. Append a row to that Google Sheet via `GoogleSheetsClient` (see shared module below)
6. Log success with `{ api_key_prefix: key.slice(0, 8), sheet_id, message_type, name }`
7. Return `200 { success: true }`

**Shared module — `_shared/google-sheets.ts`:** follows the exact pattern of `_shared/google-drive.ts`:
- `GoogleSheetsEnv` — no new env vars; uses `GOOGLE_SERVICE_ACCOUNT_JSON` via `loadGoogleAuthEnv()`
- `GoogleSheetsDeps` — `{ fetch, getToken }` for testability
- `GoogleSheetsClient` class with `appendRow(sheetId, range, values)` method
- `createGoogleSheetsClient()` factory function
- Scope: `https://www.googleapis.com/auth/spreadsheets`

### Database

New table in the existing `internal_cs` schema:

```sql
CREATE TABLE internal_cs.linkedin_tracker_clients (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key     text UNIQUE NOT NULL,
  sheet_id    text NOT NULL,
  label       text,                    -- human-readable name ("Barton", "Client A")
  created_at  timestamptz DEFAULT now()
);
```

`api_key` values are generated offline (e.g. `crypto.randomUUID()`) and inserted manually. No self-service key creation in V1.

### Google Sheets Integration

Reuses `GOOGLE_SERVICE_ACCOUNT_JSON` already in Doppler. The service account must be granted **Editor** access to each client's Sheet (one-time manual step per client). See client setup runbook (TODO).

The sheet is a shared template with four tabs: **Target List**, **Outreach Log**, **Scorecard**, **Interviews**. The extension writes only to **Outreach Log**.

#### Outreach Log column layout

Column A is intentionally blank. Data starts at B:

| Col | Header | Source |
|-----|--------|--------|
| A | *(blank)* | always `""` |
| B | INDUSTRY | `""` — filled in manually |
| C | COMPANY | `""` — filled in manually (headline parsing deferred to V2) |
| D | ROLE TITLE | `""` — filled in manually |
| E | PERSON'S NAME | `name` from payload |
| F | PERSON'S TITLE | `title` from payload (full headline string) |
| G | BUCKET | `""` — filled in manually |
| H | MESSAGE TYPE | `message_type` from payload |
| I | DATE | `date` formatted as `M/D/YYYY` (matches sheet convention, e.g. `5/13/2026`) |
| J | STATUS | `status` from payload (`"Sent"`) |
| K | NOTES | `message_text` from payload |

Append call: `spreadsheets.values.append` on range `Outreach Log!A:K`, `valueInputOption: "USER_ENTERED"`.

Row array: `["", "", "", "", name, title, "", message_type, formattedDate, "Sent", message_text]`

Where `formattedDate` is the `date` field from the payload converted from ISO 8601 (`2026-05-13`) to `M/D/YYYY` (`5/13/2026`) by the edge function.

Columns B–D and G are left blank by the extension — the user fills in INDUSTRY, COMPANY, ROLE TITLE, and BUCKET after the fact. This matches the existing manual workflow where context fields are added when reviewing the log.

### New Env Vars (Doppler)

| Var | Purpose |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Already exists — reused |
| `LINKEDIN_TRACKER_WEBHOOK_URL` | Full Edge Function URL, baked into extension build |

---

## Implementation Phases

### Phase 1 — Extension Skeleton + Build Pipeline

**Goal:** Chrome extension loads in developer mode; popup opens; no LinkedIn interaction yet.

- `package.json`: add `esbuild` to devDependencies; add `build:extension` script: `tsx linkedin-tracker/build.ts`
- `linkedin-tracker/src/types.ts` — `TrackerEvent`, `DebugPayload`, `STORAGE_KEYS` constants
- `linkedin-tracker/src/manifest.json` — static manifest
- `linkedin-tracker/src/content.ts` — stub: logs "content script loaded" to console
- `linkedin-tracker/src/background.ts` — stub: listens for messages, logs receipt
- `linkedin-tracker/src/popup/popup.html` + `popup.ts` — API key input + save (validates non-empty before saving); reads/writes `chrome.storage.sync`; shows "Configured" (green) / "Not configured" (grey); last logged timestamp; last error state; debug mode toggle
- `linkedin-tracker/tsconfig.json` — targets ES2020, `lib: ["ES2020", "DOM"]`, no `noEmit`
- `linkedin-tracker/build.ts` — esbuild script producing `dist/`; injects `LINKEDIN_TRACKER_WEBHOOK_URL` via `define`
- `tests/__mocks__/chrome.ts` — mock `chrome.storage.sync`, `chrome.storage.local`, `chrome.runtime.sendMessage`, `chrome.runtime.onMessage`
- `vitest.config.ts` — add `setupFiles: ['tests/__mocks__/chrome.ts']` entry; `chrome.ts` assigns `global.chrome = { storage: { sync: ..., local: ... }, runtime: { sendMessage: ..., onMessage: ... } }` (not a module alias — `chrome` is a global, not an ES import)
- `tests/unit/extension/popup.test.ts`:
  - api_key save writes to storage
  - api_key loads from storage on open
  - empty api_key does not save (shows validation error)
  - status indicator: "Configured" when key present, "Not configured" when absent/empty
  - last_logged_at displays formatted timestamp
  - last_error shows red "Last POST failed" when set; hidden when absent
  - debug_mode toggle reads/writes storage

**Done when:** `pnpm build:extension` succeeds; loading `dist/` as an unpacked extension in Chrome shows the popup with a working API key save; console confirms content script loaded on linkedin.com.

---

### Phase 2 — Connection Request Detection

**Goal:** Clicking "Send invite" on LinkedIn fires a captured event visible in the background service worker console.

- `content.ts` — event delegation listener for `aria-label="Send invite"` and `aria-label="Send without a note"` buttons
- Scrape name + headline from the invite modal; `console.warn` + partial payload if element not found
- Build `TrackerEvent` payload via `buildEvent()` helper (no POST yet — `chrome.runtime.sendMessage` only)
- `sendMessage()` wrapped in try/catch; swallows Chrome runtime errors with `console.warn`
- `background.ts` — receives message, logs full payload to console
- Deduplication guard: module-level `{ name, ts }` tuple; drops events within 500 ms for same name
- `tests/unit/extension/content.test.ts` — JSDOM fixtures:
  - Invite modal: assert correct payload shape (`message_type: "Connection Request"`)
  - Invite modal: name element missing → `console.warn` called, partial payload sent
  - Dedup guard fires within 500 ms → second event dropped
  - Dedup guard does NOT fire after 500 ms → second event passes through
  - debug_mode=true + scrape success → `debug` field ABSENT from payload
  - debug_mode=true + scrape failure → `debug` field present, `container_html` ≤ 10 000 chars

**Done when:** Open a LinkedIn profile, click "Connect" → fill invite modal → click "Send invite" → background service worker console logs a correctly-shaped `TrackerEvent` with `message_type: "Connection Request"`.

---

### Phase 3 — Direct Message Detection

**Goal:** Sending a LinkedIn DM via button click OR Enter key fires a captured event.

- `content.ts` — two triggers for direct message detection:
  - **Button click:** event delegation for `aria-label="Send message"` button
  - **Enter key:** `keydown` listener on `document.body`; fires when `e.key === 'Enter'` (not Shift+Enter) and active element is the messaging composer `[contenteditable]`
  - Both triggers call the same `handleDirectMessage()` handler; dedup guard prevents double-fire when both activate in the same send action
- Scrape name + headline from conversation header; `console.warn` + partial if missing
- Capture message text from `[contenteditable]` synchronously before send fires
- `tests/unit/extension/content.test.ts` — add fixtures:
  - DM button click: assert correct payload shape (`message_type: "Direct Message"`, `message_text` populated)
  - DM Enter key: same assertions
  - DM button click + Enter key within 500 ms: dedup guard drops duplicate
  - Conversation header missing: `console.warn` called, partial payload sent

**Done when:** Open a LinkedIn conversation, type a message, press Enter OR click Send → background console logs a `TrackerEvent` with `message_type: "Direct Message"` and the correct message text.

---

### Phase 4 — Edge Function + Sheets Write

**Goal:** Events POST to Supabase and appear as rows in the target Google Sheet.

- `supabase/functions/_shared/google-sheets.ts` — `GoogleSheetsClient` following `google-drive.ts` pattern: `GoogleSheetsEnv`, `GoogleSheetsDeps`, `appendRow(sheetId, range, values)`, `createGoogleSheetsClient()` factory
- `supabase/migrations/YYYYMMDDHHMMSS_internal_cs_linkedin_tracker.sql` — `internal_cs.linkedin_tracker_clients` table
- `supabase/functions/linkedin-tracker-webhook/index.ts` — thin entrypoint
- `supabase/functions/linkedin-tracker-webhook/linkedin-tracker-webhook.ts` — full handler with two-layer try/catch; validate fields; lookup sheet_id; log debug if present; append row; log success with `api_key_prefix`
- `background.ts` — reads `api_key`, POSTs to Edge Function URL; on 200: write `last_logged_at`, clear `last_error`; on fetch throw or non-200: write `last_error`, log `console.error`
- `popup.ts` — reads `last_error` and displays red "Last POST failed: [date]" if set
- `tests/unit/shared/google-sheets.test.ts` — `appendRow` happy path; Sheets API non-200 throws `InternalServiceException`
- `tests/unit/functions/linkedin-tracker-webhook.test.ts`:
  - Valid payload → 200, row appended (mock Sheets API); assert exact row array `["", "", "", "", name, title, "", message_type, "5/13/2026", "Sent", message_text]` — verifies column positions and date conversion
  - Unknown api_key → 403
  - Missing required fields → 400
  - `debug` field present → logged, NOT in row array
  - Sheets API throws → 500
- `tests/unit/extension/background.test.ts`:
  - api_key absent → no fetch, console.warn
  - fetch throws → `last_error` written, `last_logged_at` not updated
  - 403 response → `last_error` written, `last_logged_at` not updated
  - 200 response → `last_logged_at` updated, `last_error` cleared
- `vitest.config.ts` — add mock alias for Sheets API (if Deno URL import used in `google-sheets.ts`)

**Done when:** Extension configured with a valid api_key → send a connection request → row appears in the configured Google Sheet within 5 seconds. Popup shows "Last logged: [timestamp]". Configuring a wrong api_key → popup shows "Last POST failed".

---

## Edge Cases & Risk

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| LinkedIn updates `aria-label` strings | H | M | `console.warn` (not throw) on element not found; partial payload still routes; extension update required |
| Double-fire from bubbled click events or click+Enter | M | L | 500 ms deduplication guard on `(name, ts)` in content script |
| Send fires before DOM scrape completes | M | M | Scrape synchronously on click/keydown (DOM still present before modal animates out) |
| `company` mixed into headline | H | L | Log full headline as `title`; leave `company` as `""` in V1 |
| Service worker hibernates between sends | L | L | All state in `chrome.storage`; service worker re-activates on message |
| API key not configured | M | M | Background checks storage before POST; logs warning and skips; popup shows grey "Not configured" |
| Google Sheet not shared with service account | M | H | Sheets API returns 403; Edge Function returns 500; background writes `last_error`; popup shows "Last POST failed" |
| Sheets API quota (100 req/100s per user) | L | L | Volume is low; no mitigation needed in V1 |
| `debug.container_html` captures message thread PII | M | M | 10 000-char cap; document that debug mode may capture message content; use only during active debugging |
| `sendMessage()` throws (service worker not yet alive) | L | L | try/catch in content script; swallow with `console.warn` |
| Network error during POST | L | M | try/catch in background; writes `last_error`; popup signals failure |

---

## Acceptance Criteria

- [ ] `pnpm build:extension` produces a valid `dist/` loadable as an unpacked Chrome extension
- [ ] `pnpm typecheck` passes (including `linkedin-tracker/tsconfig.json`)
- [ ] `pnpm test` passes (all unit tests)
- [ ] `pnpm lint` and `pnpm format` pass
- [ ] Migration file follows `YYYYMMDDHHMMSS_internal_cs_linkedin_tracker.sql` naming convention
- [ ] Extension loads on `linkedin.com` without console errors
- [ ] Connection request send (click) → row in sheet within 5 s; `message_type` = "Connection Request"
- [ ] Direct message send via button click → row in sheet within 5 s; `message_type` = "Direct Message", `message_text` populated
- [ ] Direct message send via Enter key → row in sheet within 5 s; same shape as button click
- [ ] Unknown `api_key` → Edge Function returns 403; popup shows "Last POST failed"
- [ ] Network failure during POST → popup shows "Last POST failed"
- [ ] Missing `api_key` in storage → extension logs warning, no POST attempted, popup shows grey "Not configured"
- [ ] Empty string saved as api_key → popup treats as "Not configured" (grey)
- [ ] `debug_mode=true` + successful scrape → `debug` field absent from payload
- [ ] `debug_mode=true` + scrape failure → `debug` field present; `container_html` ≤ 10 000 chars
- [ ] No hardcoded secrets in source; Edge Function URL injected at build time via `esbuild` define
- [ ] `LINKEDIN_TRACKER_WEBHOOK_URL` documented in Doppler

---

## Known IDs

| Resource | Value |
|---|---|
| Barton's tracking sheet ID | `1m3weGKuymGFjAXPWKO2fjcBgswdD_ubHWrEdK17VcqM` |

First `linkedin_tracker_clients` row: `api_key` = generated UUID, `sheet_id` = above, `label` = "Barton".

---

## Open Questions

*None — all answered.*

---

## Deferred

- **Connection request note text:** Requests sent *with* a custom note — capturing the note text in `message_text` is feasible (separate `<textarea>` in the note composer) but adds selector complexity. Deferred to V2; leave a `TODO` comment in `content.ts` at the connection request handler.
- **Chrome Web Store listing:** Sideloaded (unpacked extension) for now. Web Store listing deferred — requires $5 developer fee + review. **Before submitting:** remove the debug mode toggle from the popup UI and strip the `debug` field from the payload entirely — sending container HTML to an external server will trigger store review scrutiny even when opt-in.
- **Company extraction from headline:** Parse "Role | Company | ..." pattern from `title` to populate the COMPANY column automatically. Deferred to V2.
- **Self-service api_key creation:** Manual DB insertion per client is sufficient for V1 client count.
