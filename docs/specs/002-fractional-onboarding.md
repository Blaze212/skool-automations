# Spec 055: Fractional Client Onboarding Automation

## Context

When Barton confirms a new Fractional Advisory client, he currently spends ~10 minutes manually:
1. Creating a Google Drive folder and copying the workbook template
2. Sending a welcome email with Drive access and scheduling links
3. Creating a Trello tracking card with links to the Drive folder and workbook
4. Finding the client in the Skool community and granting course access

This spec automates all four steps in five incremental phases. Each phase is independently shippable and valuable. Barton fills out a single Google Form; the Edge Function grows one capability per phase.

**Dual purpose:** This automation fulfills Barton's own client onboarding AND becomes the reusable product offered to fractional advisory clients when they land their own clients.

---

## Phases at a Glance

| Phase | What ships | Value delivered |
|---|---|---|
| 1 — Trigger + DB | Form → Apps Script → Edge Function skeleton → DB record | Proves the pipeline works; client log exists |
| 2 — Drive | Create folder, copy workbook, share with client | Biggest manual time save; client has workspace instantly |
| 3 — Gmail | Welcome email with Drive links + scheduling link | Client receives personalized onboarding email automatically |
| 4 — Trello | Create tracking card with Drive links | Barton has a card in the pipeline without manual copy |
| 5 — Skool | Cookie refresh script + GitHub Actions + course grant | Fully hands-free; client gets course access automatically |

---

## Trigger

Barton fills out the **Fractional Client Onboarding** Google Form. On submission:

1. The response is written to the linked Google Sheet
2. Apps Script `onFormSubmit` fires and POSTs the row data to the Supabase Edge Function
3. The Edge Function runs all steps end-to-end

---

## Google Form Fields

| Field | Notes |
|---|---|
| Client full name | Used for folder/card naming and Skool lookup |
| Email for Google Drive sharing | Drive folder + workbook shared to this address |
| Email for Skool (leave blank if same as above) | Used for Skool member lookup |
| Program start date | Stored in DB; used in email template |
| Notes (optional) | Stored in DB; surfaced on Trello card |

---

## Apps Script (Generic — reused for all forms)

One script attached to the response Google Sheet. Only `WEBHOOK_URL` in Script Properties changes per form — the code never changes.

```javascript
function onFormSubmit(e) {
  const webhookUrl = PropertiesService.getScriptProperties()
                       .getProperty('WEBHOOK_URL');
  UrlFetchApp.fetch(webhookUrl, {
    method: 'POST',
    contentType: 'application/json',
    payload: JSON.stringify({
      formId: e.source.getId(),
      timestamp: new Date().toISOString(),
      data: e.namedValues
    })
  });
}
```

Set `WEBHOOK_URL` in Script Properties → the Supabase Edge Function URL for `fractional-form-webhook`.

---

## Architecture

```
[Barton fills Google Form]
        │
        │ auto-populates
        ▼
[Google Sheet — response log]
        │
        │ onFormSubmit (Apps Script)
        ▼
[POST /functions/v1/fractional-form-webhook]
        │
        ├──→ Supabase DB              insert fractional_clients row
        │                             insert workflow_run (status: running)
        │
        ├──→ Google Drive API
        │     1. Create folder "{Full Name} — Fractional Advisory" inside parent folder
        │     2. Copy workbook template into folder, rename to same
        │     3. Share folder with client's drive_email (writer)
        │
        ├──→ Gmail API
        │     Send welcome email to drive_email with:
        │       - Drive folder link
        │       - Workbook link
        │       - Scheduling link (Calendly)
        │       - Program start date
        │
        ├──→ Trello API
        │     1. Copy template card to "New Clients" list on Fractional Advisory board
        │     2. Rename card to client's full name
        │     3. Add Drive folder URL + workbook URL to card description
        │
        └──→ Skool API (raw fetch with stored cookies)
              1. GET /career-systems/-/members?q={full_name} → parse __NEXT_DATA__ → extract member_id
              2. POST /groups/{groupId}/update-member-course-permission
                 body: { "member_id": "<id>", "grant": ["57877eaeabb442dc85d41a24d65bd183"] }
              │
              └──→ Supabase DB
                    Update fractional_clients with:
                      trello_card_id, drive_folder_id, workbook_doc_id, skool_member_id
                    Update workflow_run: status=complete (or status=failed + error)
```

---

## Shared Modules

All modules live in `supabase/functions/_shared/`. Each is a standalone TypeScript module importable in Deno.

### `drive.ts`

```typescript
export async function createClientFolder(clientName: string): Promise<string>
  // Creates "{clientName} — Fractional Advisory" inside FRACTIONAL_DRIVE_FOLDER_ID
  // Returns new folder ID

export async function copyWorkbookTemplate(folderId: string, clientName: string): Promise<string>
  // Copies FRACTIONAL_WORKBOOK_TEMPLATE_ID into folderId, renames it
  // Returns new doc ID

export async function shareFolder(folderId: string, email: string): Promise<void>
  // Grants writer access to email
```

### `gmail.ts`

```typescript
export async function sendWelcomeEmail(params: {
  to: string;
  clientName: string;
  driveFolderUrl: string;
  workbookUrl: string;
  programStartDate: string;
}): Promise<void>
```

Welcome email template:

```
Subject: Welcome to Fractional Advisory, {firstName}!

Hi {firstName},

Excited to get started! Here's what you need to get going:

Your workspace: {driveFolderUrl}
Your workbook: {workbookUrl}

We kick off on {programStartDate}. Use this link to book sessions: [Calendly link]

Talk soon,
Barton
```

### `trello.ts`

```typescript
export async function createClientCard(params: {
  clientName: string;
  driveFolderUrl: string;
  workbookUrl: string;
  notes?: string;
}): Promise<string>
  // Copies template card (TRELLO_TEMPLATE_CARD_ID) to "New Clients" list
  // Returns new card ID
```

### `skool.ts`

```typescript
export async function findMemberByName(fullName: string): Promise<string | null>
  // GET https://www.skool.com/career-systems/-/members?q={fullName}
  // Parses __NEXT_DATA__ JSON from HTML response
  // Returns member_id string or null if not found

export async function grantCourseAccess(memberId: string, courseId: string): Promise<void>
  // POST https://api2.skool.com/groups/{SKOOL_GROUP_ID}/update-member-course-permission
  // body: { member_id, grant: [courseId] }
  // Uses SKOOL_COOKIES from Doppler for auth
```

**Cookie auth pattern:**

```typescript
const cookies = JSON.parse(Deno.env.get('SKOOL_COOKIES')!);
const cookieHeader = cookies.map((c: { name: string; value: string }) =>
  `${c.name}=${c.value}`
).join('; ');

const res = await fetch(url, {
  method: 'POST',
  headers: {
    'Cookie': cookieHeader,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(payload),
});
```

---

## Edge Function: `fractional-form-webhook`

**Location:** `supabase/functions/fractional-form-webhook/index.ts`

**Auth:** Supabase anon key in `Authorization: Bearer` header sent by Apps Script (or no auth check if the URL is treated as a secret).

**Steps:**

```typescript
// 1. Parse and validate form payload
const { data } = await req.json();
const clientName = data['Client full name'][0];
const driveEmail = data['Email for Google Drive sharing'][0];
const skoolEmail = data['Email for Skool'][0] || driveEmail;
const startDate = data['Program start date'][0];
const notes = data['Notes']?.[0] ?? null;

// 2. Insert client record + workflow run
const { data: client } = await supabase
  .from('internal_automations.fractional_clients')
  .insert({ full_name: clientName, drive_email: driveEmail, skool_email: skoolEmail,
            program_start_date: startDate, notes })
  .select().single();

const { data: run } = await supabase
  .from('internal_automations.fractional_workflow_runs')
  .insert({ client_id: client.id, workflow: 'onboard', status: 'running', started_at: new Date() })
  .select().single();

// 3. Google Drive
const folderId = await createClientFolder(clientName);
const docId = await copyWorkbookTemplate(folderId, clientName);
await shareFolder(folderId, driveEmail);

const driveFolderUrl = `https://drive.google.com/drive/folders/${folderId}`;
const workbookUrl = `https://docs.google.com/spreadsheets/d/${docId}`;

// 4. Gmail
await sendWelcomeEmail({ to: driveEmail, clientName, driveFolderUrl, workbookUrl, programStartDate: startDate });

// 5. Trello
const trelloCardId = await createClientCard({ clientName, driveFolderUrl, workbookUrl, notes });

// 6. Skool
const memberId = await findMemberByName(clientName);
if (memberId) {
  await grantCourseAccess(memberId, Deno.env.get('SKOOL_COURSE_ID')!);
}

// 7. Update DB with results + mark complete
await supabase.from('internal_automations.fractional_clients').update({
  trello_card_id: trelloCardId,
  drive_folder_id: folderId,
  workbook_doc_id: docId,
  skool_member_id: memberId ?? null,
}).eq('id', client.id);

await supabase.from('internal_automations.fractional_workflow_runs').update({
  status: 'complete',
  completed_at: new Date(),
}).eq('id', run.id);
```

**Error handling:** Wrap entire body in try/catch. On error, update `workflow_runs` with `status: 'failed'` and `error: err.message`. Return 200 regardless (Apps Script doesn't retry on non-200).

---

## Database Migration

**File:** `supabase/migrations/20260601000000_fractional.sql`

```sql
CREATE TABLE internal_automations.fractional_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name text NOT NULL,
  drive_email text NOT NULL,
  skool_email text NOT NULL,
  trello_card_id text,
  drive_folder_id text,
  workbook_doc_id text,
  skool_member_id text,
  program_start_date date,
  notes text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE internal_automations.fractional_workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid REFERENCES internal_automations.fractional_clients(id),
  workflow text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'running', 'complete', 'failed')),
  error text,
  started_at timestamptz,
  completed_at timestamptz
);
```

---

## Skool Cookie Refresh (GitHub Actions Cron)

Skool cookies expire. `scripts/refresh-skool-cookies.ts` uses `skool-cli` (Playwright) to log in and extract fresh cookies, then writes them back to Doppler as `SKOOL_COOKIES`.

**Schedule:** Twice a week (Monday + Thursday at 06:00 UTC)

**GitHub Actions workflow:** `.github/workflows/refresh-skool-cookies.yml`

```yaml
name: Refresh Skool Cookies
on:
  schedule:
    - cron: '0 6 * * 1,4'
  workflow_dispatch:

jobs:
  refresh:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - run: pnpm install
      - run: npx playwright install chromium --with-deps
      - run: doppler run -- pnpm tsx scripts/refresh-skool-cookies.ts
        env:
          DOPPLER_TOKEN: ${{ secrets.DOPPLER_TOKEN }}
```

**`scripts/refresh-skool-cookies.ts`:**

```typescript
import { SkoolClient } from 'skool-cli';

const client = new SkoolClient({
  email: process.env.SKOOL_EMAIL!,
  password: process.env.SKOOL_PASSWORD!,
});

await client.login();
const cookies = await client.getCookies(); // returns JSON array

// Write back to Doppler
const res = await fetch(
  `https://api.doppler.com/v3/configs/config/secret`,
  {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.DOPPLER_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      project: process.env.DOPPLER_PROJECT,
      config: process.env.DOPPLER_CONFIG,
      secrets: { SKOOL_COOKIES: JSON.stringify(cookies) },
    }),
  }
);

if (!res.ok) throw new Error(`Doppler write failed: ${await res.text()}`);
console.log('SKOOL_COOKIES refreshed successfully');

await client.close();
```

---

## New Env Vars (Doppler)

| Var | Purpose |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Already exists — reuse for Drive + Gmail |
| `TRELLO_API_KEY` | Trello REST API key |
| `TRELLO_TOKEN` | Trello user token |
| `TRELLO_BOARD_ID` | `kPkBmPHb` |
| `TRELLO_TEMPLATE_CARD_ID` | `7TLXJXkG` |
| `FRACTIONAL_DRIVE_FOLDER_ID` | `1L9tPoCkyIsqzRTVdwxg0LfzW1EszsDSn` |
| `FRACTIONAL_WORKBOOK_TEMPLATE_ID` | `1UZGnCnJGBCGX6z31wxj94cVRUOZFnGhnesZOir44NDQ` |
| `SKOOL_COURSE_ID` | `57877eaeabb442dc85d41a24d65bd183` |
| `SKOOL_GROUP_ID` | `1a0f19d9d9274b7db163fbaf242fdab0` |
| `SKOOL_COOKIES` | JSON cookie array — written by refresh script |
| `SKOOL_EMAIL` | Barton's Skool login (for cookie refresh script) |
| `SKOOL_PASSWORD` | Barton's Skool password (for cookie refresh script) |
| `DOPPLER_PROJECT` | Doppler project name (for refresh script to write back) |
| `DOPPLER_CONFIG` | Doppler config name (e.g., `prd`) |

---

## Phase Details

### Phase 1 — Trigger + DB

**Goal:** Form submission creates a client record and workflow run. Proves the full pipeline path end-to-end.

**Ships:**
- `supabase/migrations/20260601000000_fractional.sql` — `fractional_clients` + `fractional_workflow_runs` tables
- `supabase/functions/fractional-form-webhook/index.ts` — skeleton: parse payload, insert DB rows, return 200
- Google Form (5 fields) + linked response Sheet
- Apps Script `onFormSubmit` webhook poster with `WEBHOOK_URL` property set
- Doppler secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`

**Done when:** Submit test form → row appears in `fractional_clients` + `fractional_workflow_runs` with `status: complete`.

---

### Phase 2 — Google Drive

**Goal:** Automatically create the client workspace in Drive.

**Ships:**
- `supabase/functions/_shared/drive.ts` — `createClientFolder`, `copyWorkbookTemplate`, `shareFolder`
- Edge Function updated to call Drive module and store `drive_folder_id` + `workbook_doc_id`
- Doppler secrets: `GOOGLE_SERVICE_ACCOUNT_JSON`, `FRACTIONAL_DRIVE_FOLDER_ID`, `FRACTIONAL_WORKBOOK_TEMPLATE_ID`

**Done when:** Submit test form → Drive folder `"{Name} — Fractional Advisory"` created inside parent, workbook copied and renamed, shared with test email.

---

### Phase 3 — Gmail

**Goal:** Client receives a welcome email immediately after form submission.

**Ships:**
- `supabase/functions/_shared/gmail.ts` — `sendWelcomeEmail`
- Edge Function updated to call Gmail module after Drive step
- Welcome email template with Drive folder link, workbook link, program start date, Calendly link
- Doppler secrets: none new (reuses `GOOGLE_SERVICE_ACCOUNT_JSON`), but confirm Gmail send-as address

**Done when:** Submit test form → welcome email arrives in test inbox with correct Drive links and start date.

---

### Phase 4 — Trello

**Goal:** A tracking card appears in the "New Clients" list automatically.

**Ships:**
- `supabase/functions/_shared/trello.ts` — `createClientCard`
- Edge Function updated to call Trello module and store `trello_card_id`
- Doppler secrets: `TRELLO_API_KEY`, `TRELLO_TOKEN`, `TRELLO_BOARD_ID`, `TRELLO_TEMPLATE_CARD_ID`

**Done when:** Submit test form → card appears in "New Clients" list named after client, with Drive folder and workbook links in the description.

---

### Phase 5 — Skool

**Goal:** Client gets course access without Barton lifting a finger.

**Ships:**
- `supabase/functions/_shared/skool.ts` — `findMemberByName`, `grantCourseAccess`
- `scripts/refresh-skool-cookies.ts` — Playwright login → extract cookies → write to Doppler
- `.github/workflows/refresh-skool-cookies.yml` — cron Mon + Thu 06:00 UTC + `workflow_dispatch`
- Edge Function updated to call Skool module and store `skool_member_id`
- Doppler secrets: `SKOOL_COOKIES`, `SKOOL_EMAIL`, `SKOOL_PASSWORD`, `SKOOL_COURSE_ID`, `SKOOL_GROUP_ID`, `DOPPLER_PROJECT`, `DOPPLER_CONFIG`

**Done when:** Run cookie refresh script manually → `SKOOL_COOKIES` populated in Doppler → submit test form → Skool member found → course access granted → `skool_member_id` stored in DB.

---

## Known IDs

| Resource | Value |
|---|---|
| Google Drive parent folder | `1L9tPoCkyIsqzRTVdwxg0LfzW1EszsDSn` |
| Workbook template doc ID | `1UZGnCnJGBCGX6z31wxj94cVRUOZFnGhnesZOir44NDQ` |
| Trello board ID | `kPkBmPHb` |
| Trello template card ID | `7TLXJXkG` |
| Trello list (new cards) | "New Clients" |
| Skool community slug | `career-systems` |
| Skool group ID | `1a0f19d9d9274b7db163fbaf242fdab0` |
| Skool course ID (Fractional Advisory) | `57877eaeabb442dc85d41a24d65bd183` |

---

## Edge Cases & Mitigations

### 1. Skool member not found by name
The name on the form may not exactly match the Skool display name (nickname, middle name, etc.).

**Mitigations:**
- Log `skool_member_id = null` to DB; workflow still marks `complete` (the other 3 steps succeeded)
- Surface a Slack/email alert to Barton: "Skool member not found for {name} — grant course access manually"
- Consider fuzzy match: if multiple results, pick the one whose email matches `skool_email` (requires fetching member profile)

### 2. Skool cookies are expired
Cookie refresh runs twice a week but could have expired between runs (e.g., Skool invalidated all sessions).

**Mitigations:**
- On 401/403 from Skool API, log error and mark Skool step failed (not the whole workflow)
- Alert Barton; trigger cookie refresh manually via `workflow_dispatch`
- Other 3 steps (Drive, Gmail, Trello) succeed regardless

### 3. Drive sharing fails (email not a Google account)
Client may not have a Google account for `drive_email`.

**Mitigations:**
- Catch sharing error; log to workflow run; continue with remaining steps
- Workbook is still created; Barton can share manually

### 4. Trello template card not found
If `TRELLO_TEMPLATE_CARD_ID` has been deleted or moved.

**Mitigations:**
- Validate template card exists on Edge Function startup; if missing, skip Trello step and alert
- Keep the template card pinned / archived but not deleted

### 5. Duplicate form submission (Barton submits form twice)
Two workflow runs fire for the same client.

**Mitigations:**
- Before inserting, check `fractional_clients` for existing `full_name` + `drive_email` combination
- If found within last 10 minutes, skip and return 200 (idempotency guard)
- Second submission creates a second Drive folder with the same name — not catastrophic but messy

### 6. Apps Script fires but Edge Function is down
Supabase Edge Functions have high uptime but can have cold-start issues.

**Mitigations:**
- Apps Script logs the HTTP response; Barton can re-trigger by re-submitting the form
- Add Apps Script retry: on non-200 response, wait 30s and retry once

### 7. Gmail rate limits / quota
Google service accounts have sending limits.

**Mitigations:**
- Fractional onboarding volume is low (< 5 clients/month); quota is not a concern
- Use `users.messages.send` via the service account impersonating Barton's Gmail

### 8. Skool course ID changes
Skool may retire or rename the Fractional Advisory course.

**Mitigations:**
- `SKOOL_COURSE_ID` is a Doppler env var — update without redeployment
- Monitor course grant responses for errors; alert on failure

---

## Open Questions

- [ ] Confirm Calendly link to embed in welcome email
- [ ] Confirm welcome email sender address (Barton's Gmail via service account impersonation)
- [ ] `skool-cli` `getCookies()` method — confirm exact API for extracting cookies after Playwright login, or write custom extraction if not exposed
