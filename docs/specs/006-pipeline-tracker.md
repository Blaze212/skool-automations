# Pipeline Tracker Chrome Extension

**Status:** Draft
**Owner:** Barton Holdridge
**Last updated:** 2026-05-21

## Objective

A Chrome extension that captures LinkedIn outreach activity (connection requests and direct
messages) and upserts each contact into a "People" sheet in Barton's internal pipeline Google
Sheet. One row per person, keyed by LinkedIn URL. The extension fires silently on natural send
actions — no manual data entry required for the captured fields.

This is a standalone extension separate from the LinkedIn Activity Tracker (`linkedin-tracker/`),
which continues to serve fractional clients unchanged.

---

## Non-goals

- No state machine or automated stage transitions (future work — see Open Questions)
- No scraping of profile pages beyond what's visible in the send modal or conversation header at
  the time of send
- No reply detection (no tracking when someone replies to a DM)
- No multi-sheet or multi-user support (single sheet, single API key — Barton only)
- No Firefox or Safari support (Chrome/Chromium only, Manifest V3)
- Not replacing Skool script columns (Date joined, Skool ID stay out of plugin scope)

---

## Business Rationale

Barton's personal pipeline sheet tracks prospects from first LinkedIn touch through conversion or
loss. The fields that can be captured automatically (name, URL, title, connection date, first DM
date, last touch, branch) are currently filled manually — error-prone and skipped under pressure.
This extension fills those columns the moment the action happens, so the pipeline stays accurate
without behavioral change.

---

## Sheet Structure

Sheet name: **People**
Google Sheet ID: _(configured at setup time)_

Columns are addressed by header title at runtime — column order can be changed freely in the
sheet without breaking the plugin. The backend reads row 1 to resolve positions before every
operation.

| Header             | Source              | Notes                                             |
| ------------------ | ------------------- | ------------------------------------------------- |
| Name               | Plugin              | Scraped from LinkedIn at time of send             |
| LinkedIn URL       | Plugin              | Normalized profile URL — primary upsert key       |
| Title              | Plugin              | Full LinkedIn headline at time of send            |
| Date connected     | Plugin              | Date connection request sent (`YYYY-MM-DD`)       |
| Date first DM sent | Plugin              | Date of first outbound DM (`YYYY-MM-DD`)          |
| Branch taken       | Plugin              | Auto-set to "Awaiting reply" on new row insert only |
| Date joined        | Skool script        | Out of plugin scope                               |
| Skool ID           | Skool script        | Out of plugin scope                               |
| Action items done  | Manual              | Free-form notes                                   |
| Current stage      | Manual              | Free-form notes                                   |
| Outcome            | Skool/Stripe        | Out of plugin scope (dropdown — see below)        |
| Date converted     | Skool/Stripe        | Out of plugin scope                               |
| Revenue            | Skool/Stripe/Manual | Out of plugin scope                               |
| Reason lost        | Manual (dropdown)   | See dropdown values below                         |
| Last touch         | Plugin / Skool      | Updated by plugin on every connection or DM event |
| Next step          | Manual (dropdown)   | See dropdown values below                         |
| Notes              | Manual              | Free-form notes                                   |

### Dropdown reference

| Column       | Valid values                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------ |
| Branch taken | Awaiting reply, Link sent (free week 1), Relationship DM, Disqualified, Hold for later          |
| Outcome      | $99/mo Group Coaching, $1000/m 1:1 Coaching, Not yet, Ghosted, Disqualified, Refunded, Unknown  |
| Reason lost  | Wrong fit, Bad timing, Price, Went with another coach, No response, Hostile                      |
| Next step    | Send first DM, Follow up, Send link, Onboard in Skool, Reply to message, Schedule call, Nudge action item, Wait, Close as lost |

---

---

# Part 1 — Chrome Extension

Lives at `pipeline-tracker/` in the `skool-automations` repo. Built with esbuild into
`pipeline-tracker/dist/`, which is the directory loaded into Chrome. Distributed as a zip of
`dist/` — never published to the Chrome Web Store.

## Repository layout

```
pipeline-tracker/
├── src/
│   ├── manifest.json             ← static; copied to dist as-is
│   ├── types.ts                  ← PipelineEvent, DebugPayload, STORAGE_KEYS constants
│   ├── content.ts                ← injected into LinkedIn tabs
│   ├── background.ts             ← service worker; reads api_key from storage, POSTs to webhook
│   ├── popup/
│   │   ├── popup.html
│   │   └── popup.ts
│   └── icons/
│       ├── icon16.png
│       ├── icon48.png
│       └── icon128.png
├── dist/                         ← compiled output (gitignored); load this into Chrome
├── build.ts                      ← esbuild script; injects PIPELINE_TRACKER_WEBHOOK_URL at build time
└── tsconfig.json
```

## Manifest V3

- `content_scripts` matches `https://www.linkedin.com/*`
- `background.service_worker` = `background.js`
- Permissions: `storage`, `scripting`
- Host permissions: the webhook URL origin

## Popup

Identical interaction model to the existing LinkedIn tracker:

- Status indicator: **Configured** (green) / **Not configured** (grey)
- API key input + Save button
- **Last logged: [timestamp]** — most recent successful POST
- **Last POST failed: [timestamp]** (red) — last failed attempt
- Debug mode toggle (off by default)

## Event payload

```typescript
interface PipelineEvent {
  api_key: string;
  event_type: 'connection_request' | 'accepted_connection' | 'direct_message';
  date: string;          // YYYY-MM-DD
  name: string;
  title: string;
  linkedin_url: string;  // normalized (see below)
  page_url: string;      // always sent; window.location.href at time of send
  message_text: string;  // DM body or invitation note text; empty string when not present
  debug?: DebugPayload;  // only present when debug mode is on AND a scrape field is missing
}

interface DebugPayload {
  button_aria_label: string;
  button_text: string;
  container_html: string;  // outerHTML of the modal or conversation container, capped at 50,000 chars
  page_url: string;
}
```

### LinkedIn URL normalization

Before storing or comparing, strip query strings and tracking params, strip trailing slashes,
ensure `https://www.linkedin.com/in/<slug>` form.

Example: `linkedin.com/in/john-doe?trk=blah_123` → `https://www.linkedin.com/in/john-doe`

### page_url

Always captured from `window.location.href` and always included in the payload. Not gated on
debug mode.

### Debug mode

When debug mode is on (toggled in popup) **and** a required scrape field (name or title) could not
be found, attach a `DebugPayload` to the event. The container HTML may contain message thread
content — users should only enable debug mode while diagnosing a broken selector.

## Console logging

Always-on `console.log` / `console.warn` / `console.error` calls — no debug mode gate. Mirrors the
existing LinkedIn tracker prefix convention; use `[Pipeline Tracker]` for content.ts and
`[Pipeline Tracker BG]` for background.ts.

### content.ts

| Moment | Level | Message |
| ------ | ----- | ------- |
| Script injected | `log` | `[Pipeline Tracker] content script loaded` |
| Every click (composed path) | `log` | `[Pipeline Tracker] click target: <TAG>` + `path [aria-label]: <tag> <label>` + `path button: <label-or-text>` + `path a: <label>` — mirrors the existing tracker's per-click dump |
| `Invite [Name] to connect` link clicked | `log` | `[Pipeline Tracker] captured (connect click): { name, title, profile_url }` |
| Send button pressed (connection) | `log` | `[Pipeline Tracker] sending (send button): { name, title, profile_url, button }` |
| DM captured | `log` | `[Pipeline Tracker] captured (direct message): { name, title, linkedin_url, message_text }` |
| Accept button clicked (Network or Profile) | `log` | `[Pipeline Tracker] captured (accept click): { name, title, linkedin_url }` |
| Name/title could not be scraped | `warn` | `[Pipeline Tracker] <Flow N>: could not find <field>` |
| `sendMessage` succeeds | `log` | `[Pipeline Tracker] sendMessage called successfully` |
| `sendMessage` throws | `warn` | `[Pipeline Tracker] sendMessage failed: <err>` |

### background.ts

| Moment | Level | Message |
| ------ | ----- | ------- |
| Service worker starts | `log` | `[Pipeline Tracker BG] service worker started, webhook URL configured: <true/false>` |
| Message received | `log` | `[Pipeline Tracker BG] onMessage received, type: <event_type> name: <name>` |
| Webhook URL not set | `error` | `[Pipeline Tracker BG] PIPELINE_TRACKER_WEBHOOK_URL is not set — rebuild with env var` |
| No API key in storage | `warn` | `[Pipeline Tracker BG] No api_key configured; skipping POST` |
| About to POST | `log` | `[Pipeline Tracker BG] POSTing to webhook: <JSON.stringify(payload)>` |
| POST succeeded | `log` | `[Pipeline Tracker BG] POST succeeded` |
| POST non-2xx | `error` | `[Pipeline Tracker BG] POST failed <status>: <body>` |
| POST timed out | `warn` | `[Pipeline Tracker BG] POST timed out` |
| POST threw | `error` | `[Pipeline Tracker BG] POST threw: <err>` |

## Scraping

### Flow 1 — Outbound connection request (`connection_request`)

Reuses patterns from `linkedin-tracker/src/content.ts`:

- Stage name on `Invite [Name] to connect` link click (stores `_pendingConnectionName`).
- Fire event on `Send without a note` / `Send invitation` / `Send invite` / `Send invite to [Name]`
  button click. Use staged name; fall back to modal heading.
- `message_text` = `""` (connection note text capture is a known V1 gap).

---

### Flow 2 — Incoming acceptance: My Network page (`accepted_connection`)

Fires when Barton clicks **Accept** on the My Network / invitation-manager page.

**Button detection:**

```
aria-label matches /^Accept (.+)'s invitation$/
```

Extract name from the regex capture group — it is always present in the aria-label so no fallback
scrape needed for name.

**Container:** Walk up from the button until reaching a `[role="listitem"]` ancestor. All
subsequent extraction is scoped to that element.

**Profile URL:** `listitem.querySelector('a[href*="/in/"]')?.href` — the first `/in/` link in the
card. Normalize before storing.

**Title:** The invitation headline is in a `<span>` that lives inside a `<p>` that is **not**
inside an `<a>` tag. Strategy:

1. Collect all `<span>` elements in the listitem.
2. Filter to those with no `<a>` ancestor within the listitem.
3. From those, take the longest text content that is ≥ 20 characters and does not start with a
   digit. That is the headline.
4. Fall back to `""` if nothing matches — log a warning; attach `DebugPayload` if debug mode is on.

**Message text:** `listitem.querySelector('[data-testid="expandable-text-box"]')?.textContent?.trim() ?? ""`

Invitation notes are optional — empty string is the normal case when no note was sent.

---

### Flow 3 — Incoming acceptance: Profile page (`accepted_connection`)

Fires when Barton clicks **Accept** on a person's profile page where they have an outstanding
invitation.

**Button detection:**

```
aria-label matches /^Accept (.+)'s request to connect$/
```

Name extracted from regex capture group, same as Flow 2.

**Container:** The profile topcard. Walk up from the button to find the nearest ancestor that
contains both an `<h2>` and an `a[href*="/in/"]`. That ancestor is the topcard root.

**Profile URL:** `topcard.querySelector('a[href*="/in/"]')?.href`. Normalize before storing.

**Title:** The topcard headline `<p>` — the first `<p>` in the topcard that is not inside an
`<a>` and contains text ≥ 20 characters. Fallback: empty string with a warning.

**Message text:** `""` — profile page shows no invitation note.

---

### Deduplication

Suppress duplicate events for the same name within 500 ms (same guard as existing tracker).
Applies across all three flows.

---

### Debug payload scope

For acceptance flows, the `DebugPayload.container_html` is the outerHTML of the `[role="listitem"]`
(My Network) or the topcard root (profile page), capped at 50,000 characters. The chat-overlay
DM flow walks up from the composer until the ancestor's outerHTML reaches the cap, so the bubble
header (recipient name/title) is included alongside the thread.

## Build

```bash
# from repo root
PIPELINE_TRACKER_WEBHOOK_URL=https://<project>.supabase.co/functions/v1/pipeline-tracker-webhook \
  pnpm build:pipeline-tracker
```

The webhook URL is baked into `background.js` at build time via an esbuild `define`, matching the
pattern in `linkedin-tracker/build.ts`.

---

---

# Part 2 — Supabase Backend

Lives in the same `skool-automations` repo under `supabase/`. Deployed automatically via CI on
push to `main` — never `supabase db push` locally.

## Repository layout

```
supabase/
├── functions/
│   └── pipeline-tracker-webhook/
│       ├── index.ts                    ← serve(handler) only
│       └── pipeline-tracker-webhook.ts ← handler(), upsert logic, Sheets API calls
└── migrations/
    └── <timestamp>_internal_cs_pipeline_tracker_clients.sql
tests/
└── unit/
    └── functions/
        └── pipeline-tracker-webhook.test.ts
```

## Database migration

```sql
CREATE TABLE internal_cs.pipeline_tracker_clients (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key    text NOT NULL UNIQUE,
  sheet_id   text NOT NULL,
  label      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

## Edge function: `pipeline-tracker-webhook`

Follows the standard two-file layout and shared utilities (`env.ts`, `supabase-admin.ts`,
`errors.ts`, `logger.ts`). Auth: validates `api_key` in the request body against
`internal_cs.pipeline_tracker_clients`. No `X-Webhook-Secret` header needed (private
single-user tool; API key in body is sufficient).

### Upsert logic

**Step 1 — Resolve column positions from header row**

Fetch `People!1:1`. Build `headerMap: Record<string, number>` of header title → 0-based column
index. Throw `ValidationException` if any required header is missing.

Required headers:
```
Name, LinkedIn URL, Title, Date connected, Date first DM sent, Branch taken, Last touch
```

**Step 2 — Find existing row**

Fetch the full LinkedIn URL column (column index from `headerMap["LinkedIn URL"]`). Scan for a
case-insensitive normalized match. Return the 1-based row index if found, otherwise null.

**Step 3 — Upsert**

On `connection_request` or `accepted_connection` event:

| Row found? | Action |
| ---------- | ------ |
| No | Append new row: Name, LinkedIn URL, Title, Date connected = today, Branch taken = "Awaiting reply", Last touch = today |
| Yes | Update Last touch = today. Backfill Name and Title if those cells are empty. Do not overwrite Branch taken or Date connected. |

Both event types write to the same columns. The distinction is semantic (outbound vs inbound) but
the data treatment is identical — Date connected records when the connection was made regardless of
direction.

On `direct_message` event:

| Row found? | Date first DM sent empty? | Action |
| ---------- | ------------------------- | ------ |
| No | — | Append new row: Name, LinkedIn URL, Title, Date first DM sent = today, Branch taken = "Awaiting reply", Last touch = today |
| Yes | Yes | Set Date first DM sent = today, Last touch = today |
| Yes | No | Update Last touch = today only |

All date values written as `YYYY-MM-DD` strings.

When appending, build a sparse array sized to `max(headerMap values) + 1` and place each value
at its resolved column index. Columns not written by the plugin are left as empty strings so
manual data and sheet formulas in other columns are not disturbed.

If `debug` is present in the payload, log it at `info` level — do not write it to the sheet.

## Setup runbook (Barton)

1. Ensure the People tab exists with the correct headers in row 1 (exact spelling matters).
2. Share the sheet with the Google service account email (`client_email` from
   `GOOGLE_SERVICE_ACCOUNT_JSON`), Editor access.
3. Insert a client row:
   ```sql
   INSERT INTO internal_cs.pipeline_tracker_clients (api_key, sheet_id, label)
   VALUES (gen_random_uuid()::text, '<SHEET_ID>', 'barton-pipeline');
   ```
4. Copy the generated `api_key`.
5. Build the extension with the production webhook URL (see Part 1 — Build).
6. Load `pipeline-tracker/dist/` as an unpacked extension in Chrome.
7. Enter the API key in the popup.
8. Test: send a LinkedIn connection request; confirm a new row appears in People within ~5 seconds.

---

---

# Open Questions / Future Work

- **State machine / automated stage transitions**: Next step and Current stage are manual today.
  A future automation could watch for Skool join events and auto-advance stage, fill Date joined /
  Skool ID, update Outcome. Separate spec.
- **Connection request note text**: Custom note text (when the user clicks "Add a note") is not
  captured — same V1 limitation as the existing tracker.
- **Branch taken refinement**: Currently auto-set to "Awaiting reply" on all new row inserts.
  Could be extended to let the user pick from the dropdown in the popup at send time if "Awaiting
  reply" turns out to be insufficient.
