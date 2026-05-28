# Skool Member Webhook

**Status:** Draft
**Owner:** Barton Holdridge
**Last updated:** 2026-05-28

## Objective

A Supabase Edge Function that receives `new_member` webhook events from Skool, logs each event to
a "Skool" tab in the pipeline tracker Google Sheet, and attempts to match the new member to an
existing row in the "People" tab. On a match, it fills the "Date joined" and "Skool ID" columns
that were previously marked "out of plugin scope" in spec 006.

---

## Non-goals

- No handling of trigger types other than `new_member` (logged and ignored in V1)
- No multi-community fan-out (one community_id → one sheet)
- No retry or queuing logic
- No Skool API calls (webhook push only, no pull)

---

## Business Rationale

When a prospect converts and joins Skool, the pipeline sheet should automatically fill in their
join date and Skool ID — closing the loop from LinkedIn outreach through conversion without manual
data entry.

---

## Architecture

### Repository layout

```
supabase/
├── functions/
│   └── skool-webhook/
│       ├── index.ts               ← serve(handler) only
│       └── skool-webhook.ts       ← handler(), matching logic, Sheets API calls
└── migrations/
    └── <timestamp>_internal_cs_pipeline_tracker_community_id.sql
tests/
└── unit/
    └── functions/
        └── skool-webhook.test.ts
```

---

## Database migration

Add `community_id` to the existing `pipeline_tracker_clients` table. Nullable for backward
compatibility with LinkedIn tracker rows that have no community.

```sql
ALTER TABLE internal_cs.pipeline_tracker_clients
  ADD COLUMN community_id text UNIQUE;

CREATE INDEX idx_pipeline_tracker_clients_community_id
  ON internal_cs.pipeline_tracker_clients (community_id)
  WHERE community_id IS NOT NULL;
```

### Populating the row

After migration, set Barton's community_id manually:

```sql
UPDATE internal_cs.pipeline_tracker_clients
SET community_id = '1a0f19d9d9274b7db163fbaf242fdab0'
WHERE label = 'barton-pipeline';
```

---

## Webhook payload type

```typescript
interface SkoolWebhookPayload {
  schemaVersion: number;
  trigger: string;
  eventAt: string;                  // ISO 8601
  community: {
    id: string;
    name: string;
  };
  data: {
    event: {
      type: string;
      occurredAt: string;
    };
    user: {
      id: string;
      name: string;
      email: string;
      firstName: string;
      lastName: string;
      createdAt: string;
      updatedAt: string;
      metadata: {
        linkLinkedin: string;
        [key: string]: unknown;
      };
      member: {
        id: string;
        [key: string]: unknown;
      };
      [key: string]: unknown;
    };
  };
}
```

---

## Edge function: `skool-webhook`

Follows the standard two-file layout and shared utilities. No `X-Webhook-Secret` header —
Skool sends no auth token. Routing is by `community_id` from the payload body.

### Auth / routing

1. Parse JSON body; throw `ValidationException` if malformed.
2. Extract `payload.community.id`.
3. Look up `sheet_id` from `internal_cs.pipeline_tracker_clients` where
   `community_id = payload.community.id`.
4. If no match: log a warning (`community_id`, `trigger`) and return `200 { success: true }`.
   Return 200 (not 4xx) so Skool does not retry indefinitely for a legitimately unknown community.
5. If `payload.trigger !== 'new_member'`: log a warning and return `200 { success: true }`.

### Processing (new_member only)

**Step 1 — Resolve sheet headers**

Fetch `People!1:1` and `Skool!1:1`. For each, build a `headerMap: Record<string, number>`
(0-based column index). Column order can be changed freely in the sheet without breaking the
function — positions are resolved fresh on every request.

Required headers for People:
```
Name, LinkedIn URL, Date joined, Skool ID
```

Required headers for Skool:
```
First Name, Last Name, Matched, Date, Event Type, LinkedIn URL, Skool ID, Payload
```

Throw `InternalServiceException` if any required header is missing from either sheet.

**Step 2 — Fetch People sheet data**

Fetch the full Name column and LinkedIn URL column values (all rows from row 2 onward).

**Step 3 — Match**

Attempt matching in priority order, stopping at the first match:

1. **LinkedIn URL** — only when `data.user.metadata.linkLinkedin` is non-empty. Normalize the
   payload URL; compare case-insensitively against each row's LinkedIn URL cell (also normalized).
   LinkedIn URLs are unique, so this is the highest-confidence signal. Sets `matchType = "exact"`.
2. **Exact name** — normalize `firstName + " " + lastName` from payload; compare
   case-insensitively (trimmed) against each row's Name cell. Sets `matchType = "exact"`.
3. **Fuzzy name** — strip credentials, emojis, and punctuation from both the sheet name and the
   payload name (see Fuzzy matching rules below); check if one normalized string contains the other
   as a whole-word substring. Sets `matchType = "partial"`.

If no match is found: `matchType = "false"`.

Note: `linkLinkedin` is often empty in Skool payloads (users don't fill it in). When it is empty,
skip step 1 and proceed directly to name matching.

**Step 4 — Update People sheet if matched**

Use `GoogleSheetsClient.updateRow` (see Shared module extensions) to write:
- `Date joined` cell → `eventAt` formatted as `M/D/YYYY h:mm:ss AM/PM` (e.g. `5/28/2026 2:34:09 PM`)
- `Skool ID` cell → `data.user.id`

Only update cells that are currently empty — do not overwrite existing values.

**Step 5 — Append to Skool sheet**

Always append one row to the `Skool` tab using the `skoolHeaderMap` resolved in Step 1. Build a
sparse array sized to `max(skoolHeaderMap values) + 1` and place each value at its resolved column
index (same pattern as the pipeline-tracker-webhook People upsert).

| Header       | Value                                               |
| ------------ | --------------------------------------------------- |
| First Name   | `data.user.firstName`                               |
| Last Name    | `data.user.lastName`                                |
| Matched      | `"exact"` \| `"partial"` \| `"false"`               |
| Date         | `eventAt` formatted as `M/D/YYYY`                   |
| Event Type   | `trigger` (e.g. `new_member`)                       |
| LinkedIn URL | `data.user.metadata.linkLinkedin` (raw, not normalized) |
| Skool ID     | `data.user.id`                                      |
| Payload      | `JSON.stringify(payload)` truncated to 50 000 chars |

Append range: `Skool!1:1` (the full row width derived from the header map).

**Step 6 — Return**

Return `200 { success: true }` with the `matchType` in the log.

---

## Fuzzy matching rules

Applied when LinkedIn URL matching and exact name matching both fail:

1. **Strip credentials** — remove trailing tokens matching a credentials list:
   `MBA`, `MS`, `PhD`, `PhD`, `JD`, `MD`, `CPA`, `PE`, `PMP`, `CFA`, `CISSP`, `CISA`,
   `CISM`, `CFP`, `SHRM`, `SPHR`, `PCC`, `MCC`, `ACC` (case-insensitive, comma/space separated).
2. **Strip emojis** — remove all characters in Unicode emoji ranges.
3. **Normalize** — trim whitespace, collapse internal runs of whitespace to single space,
   lowercase.
4. **Last-initial match** — after normalization, check if the payload name starts with the same
   first name and the sheet name's last name starts with the payload last name's initial (handles
   "John D" in sheet vs "John Doe" in payload, and vice versa).
5. **Contains match** — check if either normalized string contains the other as a substring.

A fuzzy match sets `matchType = "partial"`. Partial matches are written to the Skool tab and to
the People sheet (Date joined / Skool ID) the same as exact matches, but the "partial" value in
the Matched column makes them easy to audit.

---

## Shared module extensions (`_shared/google-sheets.ts`)

Add two methods to `GoogleSheetsClient`:

### `readRange(sheetId, range): Promise<string[][]>`

GET `spreadsheets/{sheetId}/values/{range}` with `majorDimension=ROWS`. Returns the `values`
array from the response, or `[]` if the range is empty.

### `updateRow(sheetId, range, values): Promise<void>`

PUT `spreadsheets/{sheetId}/values/{range}` with `valueInputOption=USER_ENTERED`. Used to
update specific cells by address (e.g. `People!H5`).

---

## Date formatting

Two formatters are needed:

- **Date only** (`M/D/YYYY`) — used for the `Date` column in the Skool tab. Reuse the existing
  `formatDate(iso: string): string` pattern from `linkedin-tracker-webhook.ts`. The `eventAt`
  field is a full ISO 8601 datetime — take only the date portion before formatting.
- **Datetime** (`M/D/YYYY h:mm:ss AM/PM`) — used for `Date joined` in the People tab.
  Parse the full `eventAt` ISO string and format with 12-hour clock, e.g.
  `2026-05-28T14:34:09.555Z` → `5/28/2026 2:34:09 PM`. Matches Google Sheets' default datetime
  display format so the cell is recognized as a datetime value.

---

## Sheet setup runbook

1. Open the pipeline tracker Google Sheet.
2. Add a new tab named exactly `Skool`.
3. Set row 1 headers (order does not matter, exact spelling does):
   `First Name`, `Last Name`, `Matched`, `Date`, `Event Type`, `LinkedIn URL`, `Skool ID`, `Payload`.
4. Confirm the `People` tab has `Date joined` and `Skool ID` headers in row 1 (exact spelling,
   order does not matter).
5. After migration runs, set `community_id` on Barton's `pipeline_tracker_clients` row (see
   Database migration section).
6. Configure the Skool webhook to POST to:
   `https://<project>.supabase.co/functions/v1/skool-webhook`

---

## Tests (`tests/unit/functions/skool-webhook.test.ts`)

- Valid `new_member` payload, LinkedIn URL present and matches → 200; People sheet updated; Skool row appended with `matched="exact"`
- Valid `new_member`, LinkedIn URL empty, exact name match → 200; matched="exact"
- Valid `new_member`, LinkedIn URL empty, fuzzy name match (credential suffix in sheet name) → 200; matched="partial"
- Valid `new_member`, LinkedIn URL empty, fuzzy name match (last initial only) → 200; matched="partial"
- Valid `new_member`, LinkedIn URL present but not found in People sheet → falls through to name matching
- Valid `new_member`, no match at all → 200; matched="false"; People sheet NOT updated; Skool row appended
- Unknown community_id → 200; no sheet writes; warning logged
- Trigger type not `new_member` → 200; no sheet writes; warning logged
- Malformed JSON body → 400
- `People` sheet missing required header → 500 `InternalServiceException`
- People sheet cells already populated (Date joined / Skool ID) → cells NOT overwritten
- `readRange` returns empty values array → no match, Skool row appended with matched="false"
- Sheets API throws on append → 500

---

## Open questions / future work

- **Other trigger types** (`member_churned`, `level_up`): log and ignore for now; add handling
  when needed.
- **Match confidence column**: if "partial" turns out too coarse in practice, add a `Match Notes`
  column to the Skool tab describing what matched.
- **Skool → Stripe revenue sync**: `mmbp.amount` is present in the payload; a future automation
  could write to the Revenue column in People.
- **Multiple communities**: currently one-to-one community_id → pipeline_tracker_clients row.
  Multi-community support requires no schema change — just insert additional rows.
