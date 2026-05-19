# Free Member Upsell CRM — Skool Sync & Segmentation Automation

**Status:** Phases 2, 4 & 5 implemented; Phase 3 pending
**Owner:** Barton
**Last updated:** 2026-05-19

## Objective

Build a semi-automated CRM pipeline that turns the Free Member Tracker Google Sheet into a
predictable upsell machine. A daily cron syncs Skool free-community members into the sheet, a
Google Form captures self-reported activation status, a daily Apps Script job segments
non-purchasers into Red/Yellow/Green buckets ready for targeted outreach — converting more free
members to the $497 paid program with minimal manual effort.

## Non-goals

- Replacing Google Sheets as the data store (Supabase is not involved in this system)
- Building a custom portal UI for managing the CRM
- Automating the outreach messages themselves in Phase 1 (manual send from segmented tabs)
- Syncing paid community members or any community other than the free group
- Real-time sync (daily cadence is sufficient)

## Business Rationale

The free Week 1 Attraction Offer generates consistent top-of-funnel volume but conversion to the
$497 program is inconsistent and manually intensive. This system creates a repeatable,
low-touch process: members self-report activation, the sheet auto-scores them, and daily
segmentation lists tell the coach exactly who to message and with what framing — green members
get the calm $497 invite, yellow get a nudge, red get a check-in. The fast-follow phase (T5)
eliminates manual sends entirely via Kit automations.

## Architecture

### External systems

| System | Role | Auth |
|---|---|---|
| Skool | Source of member data (name, email, Skool ID, join/login dates) | skool-cli (Playwright-based); session persisted in `SKOOL_CLI_DATA_DIR` |
| Google Sheets | Primary CRM data store | Service account key (JSON) passed via `GOOGLE_SERVICE_ACCOUNT_JSON` |
| Google Forms + Apps Script | Member check-in capture, CRM update, and daily segmentation | Google account OAuth (Apps Script runs as sheet owner) |
| Kit (ConvertKit) | Email tag sync for automated sequences | API key |
| Doppler | Secret management for local and CI runs | Doppler project config |

### No CareerSystems portal involvement

This system is entirely external to the Supabase/Cloudflare stack. No edge functions, no
migrations, no portal changes.

### Repository layout

```
automations/
  free-member-sync/
    skool-sync.ts         # T2: Skool → Sheet sync entrypoint
    kit-sync.ts           # T5: Kit tag sync entrypoint
    members-sheet.ts      # MembersSheet class (upsert, sync log, ensureSheets)
    kit-client.ts         # KitClient (tag resolution, subscriber upsert, tag sync)
    test-scripts/         # Ad-hoc scripts for exploring the Skool API
    README.md
  shared/
    env.ts                # loadEnv() — fail-fast env loader
    logger.ts             # createLogger() — pino logger factory
    skool/
      skool-client.ts     # SkoolClient wrapper (auth + member fetch)
      members-api.ts      # fetchAllMembers() — paginated Next.js data API
      types.ts            # SkoolMember, RawMemberData interfaces
    google/
      auth.ts             # getGoogleAuth() — service account factory
      sheets-client.ts    # SheetsClient (read, append, batchUpdate, ensureSheet)
      drive-client.ts     # DriveClient (future use)
```

Segmentation (T4) runs entirely in Apps Script — no files in this repo.

### Skool authentication & member fetch strategy

`skool-cli` is used **only for authentication**. Its built-in `getMembers()` is not paginated
and returns incomplete fields. After skool-cli logs in via Playwright (session persisted in
`SKOOL_CLI_DATA_DIR`), we extract the session cookie via `skool-cli`'s internal
`api.getCookies()` and use it to make direct paginated HTTP requests to the Skool Next.js
data API.

**Member fetch flow:**
1. `SkoolClient.ensureSession(group)` — calls skool-cli's `checkSession()`; if stale, calls `login()`
2. Cookie extracted via `(this.inner as any).api.getCookies()` — same call skool-cli uses internally
3. Fetch `https://www.skool.com/career-systems/-/members` (HTML) once to extract the current `_next/data` build ID from the `__NEXT_DATA__` script tag
4. For each page (30/page), fetch:
   `https://www.skool.com/_next/data/{buildId}/career-systems/-/members.json?group=career-systems&page=N`
5. Extract per member:
   - `id` → Skool ID (col B)
   - `firstName + lastName` → Name (col A)
   - `member.createdAt` → Join Date (col C)
   - `member.lastOffline` → Last Login Date (col D)
   - `member.metadata.survey` (JSON) → Current Situation (col E), Main Goal (col F), and email
   - `raw.email` → fallback email source if survey email is absent

**Email population:** Email is parsed from the onboarding survey JSON stored in
`member.metadata.survey`. The field `"What's your email address?"` is the primary source;
`raw.email` is a fallback. The sheet write is guarded: email is written only if col G is
currently empty (Zapier-populated values are never overwritten).

**`hasPurchase` / col P:** Not yet populated by the sync. Purchase/Scholarship (col P) is set
manually. The Skool members endpoint may support a `price` filter to fetch paying members by
Skool ID — this is a future enhancement.

### Sheet structure

**Main CRM tab** (`Members`) — 18 columns in this exact order:

| # | Column | Source | Type |
|---|---|---|---|
| A | Name | Skool sync | Text |
| B | Skool Id | Skool sync | Text (primary match key) |
| C | Join Date | Skool sync (`member.createdAt`) | Date (Sheets serial, formatted `MMMM D`) |
| D | Last Login Date | Skool sync (`member.lastOffline`) | Date (Sheets serial, formatted `MMMM D`) |
| E | Current Situation | Skool sync (survey JSON) | Text |
| F | Main Goal | Skool sync (survey JSON) | Text |
| G | Email | Zapier primary; Skool sync fills if empty | Text — never overwrite |
| H | Roadmap | Check-in form / manual | Y/N |
| I | Target Role | Check-in form / manual | Y/N |
| J | Resume | Check-in form / manual | Y/N |
| K | LinkedIn | Check-in form / manual | Y/N |
| L | Community | Check-in form / manual | Y/N |
| M | DM/Email Response | Manual | Y/N |
| N | Activation Score | Formula | `=IF(B2="","",COUNTIF(H2:M2,"Y"))` |
| O | Health Bucket | Formula | `=IF(N2="","",IF(N2<=1,"Red",IF(N2<=3,"Yellow","Green")))` |
| P | Purchase/Scholarship | Manual | Y/N |
| Q | First Message | Segmentation script | Text |
| R | Notes | Manual | Text |

Activation Score counts Y across columns H–M (6 activation columns).
Health Bucket: 0–1 = Red, 2–3 = Yellow, 4–6 = Green.

**Column G (Email) is never overwritten** by the Skool sync or any script if a value already
exists. `MembersSheet.upsertMembers()` reads the current cell before writing.

Date columns (C and D) are written as Google Sheets serial numbers and formatted `MMMM D` via
the Sheets API on each `ensureSheets()` call — no manual formatting needed.

**Additional tabs (auto-created by `ensureSheets()`):**
- `Sync Log` — Timestamp, Event, Status, Detail (written by both scripts)
- `Check-In Raw` — raw Google Form responses (Google Forms sets headers on first response)
- `Red_YYYYMMDD`, `Yellow_YYYYMMDD`, `Green_YYYYMMDD` — daily segmentation output (pruned after 7 days, written by Apps Script)

### Secrets & environment

Secrets are managed in **Doppler** and injected at runtime via `doppler run --`. The scripts
use `loadEnv()` from `automations/shared/env.ts` which throws immediately on any missing key.

| Secret | Used by |
|---|---|
| `SKOOL_EMAIL` | skool-sync |
| `SKOOL_PASSWORD` | skool-sync |
| `SKOOL_CLI_DATA_DIR` | skool-sync (session persistence path) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | both scripts |
| `SKOOL_FREE_MEMBER_SYNC_SHEET_ID` | both scripts |
| `KIT_API_KEY` | kit-sync |

### Running locally

```bash
pnpm skool-sync   # doppler run -- tsx automations/free-member-sync/skool-sync.ts
pnpm kit-sync     # doppler run -- tsx automations/free-member-sync/kit-sync.ts
```

Run `skool-sync` before `kit-sync` so Health Bucket values are current.

## Implementation Phases

### Phase 1 — CRM Foundation (T1) ✅

Manual setup:

- Rename/reorder columns in the existing sheet to match the 18-column schema above
- Enter Activation Score formula in column N: `=IF(B2="","",COUNTIF(H2:M2,"Y"))`
- Enter Health Bucket formula in column O: `=IF(N2="","",IF(N2<=1,"Red",IF(N2<=3,"Yellow","Green")))`
- `Sync Log` tab is auto-created by `ensureSheets()` on first sync run; can be created manually first if preferred
- `Check-In Raw` tab: Google Forms populates headers on first response

### Phase 2 — Skool Sync (T2) ✅

**Files:** `automations/shared/skool/`, `automations/free-member-sync/members-sheet.ts`, `automations/free-member-sync/skool-sync.ts`

- `SkoolClient.ensureSession()` — checks existing session, re-logs in if expired
- `fetchAllMembers()` — extracts build ID from HTML, paginates the Next.js data API, normalizes raw member data
- `MembersSheet.upsertMembers()` — reads all Skool IDs from col B; patches cols A, C–G on existing rows (never overwrites col G if populated); appends new rows
- `MembersSheet.appendSyncLog()` — writes one row to Sync Log tab per run (success or error)
- `skool-sync.ts` — orchestrates: ensureSession → fetchAllMembers → upsertMembers → appendSyncLog

**GitHub Actions cron** (`0 6 * * *`): not yet created. Will use Doppler CLI or GitHub Actions secrets — TBD.

### Phase 3 — Check-In Form Bridge (T3)

Manual setup + Apps Script (no GitHub Actions, no repo files):

- Create Google Form "Week 1 Check-In":
  - Email address (short answer, required)
  - Current situation (short answer)
  - Main goal / target role (short answer)
  - Completed the roadmap? (multiple choice: Yes / No)
  - Uploaded your resume? (multiple choice: Yes / No)
  - Updated your LinkedIn? (multiple choice: Yes / No)
  - Joined the community tab? (multiple choice: Yes / No)
- Set response destination to the `Check-In Raw` tab of the CRM sheet
- In Apps Script (bound to sheet), create `onFormSubmit(e)` trigger:
  - Reads email from response
  - Finds matching row in `Members` tab by col G (Email)
  - Writes: Current Situation (E), Main Goal (F), Roadmap (H), Resume (J), LinkedIn (K), Community (L)
  - Activation Score (N) and Health Bucket (O) recalculate via formula automatically
  - If email not found: appends a warning row to `Sync Log`
- Embed form link in Skool classroom welcome post

### Phase 4 — Daily Segmentation (T4) ✅

**File:** `automations/free-member-sync/appscripts/segmentation.gs`

- `runDailySegmentation()` — reads all `Members` rows; skips purchasers (col P = "Y"); groups non-purchasers by Health Bucket (col O); creates or replaces `{Bucket}_{YYYYMMDD}` tab for each bucket; batch-writes First Message back to col Q; prunes segmentation tabs older than 7 days; appends to Sync Log
- `createDailyTrigger()` — run once from the Apps Script editor to install the 7am time-driven trigger; idempotent (no-op if trigger already exists)
- Missing step for Yellow messages is computed at runtime from cols H–M (first incomplete activation column name is used)

**Deployment:** Copy `segmentation.gs` and `appsscript.json` into the sheet-bound Apps Script project. Test by running `runDailySegmentation()` manually from the editor. Then run `createDailyTrigger()` once to arm the daily 7am trigger.

**Message templates (customise `TEMPLATES` constants in the script):**

- Green: `"Hey [Name] — looks like you're making great progress. Wanted to share how the full program could accelerate your [Main Goal] search…"`
- Yellow: `"Hey [Name] — just checking in. Have you had a chance to finish [missing step]?"`
- Red: `"Hey [Name] — wanted to make sure you found everything okay in Week 1. What's been the biggest blocker?"`

### Phase 5 — Kit Tag Sync (T5) ✅

**Files:** `automations/free-member-sync/kit-client.ts`, `automations/free-member-sync/kit-sync.ts`

- `KitClient.syncSubscriberBucket(email, bucket)`:
  - Upserts Kit subscriber by email (creates if absent)
  - Fetches subscriber's current tag list
  - Adds the correct `Free-{Bucket}` tag if missing; removes the other two if present
  - Bucket `null` (purchaser) → removes all three tags
  - Tag IDs are fetched once and cached in-process
- `kit-sync.ts` — reads all `Members` rows; skips rows without email or without a valid Health Bucket; calls `syncSubscriberBucket` per row; logs counts; appends to Sync Log
- `HealthBucket` type: `'Red' | 'Yellow' | 'Green'`; tag names: `Free-Red`, `Free-Yellow`, `Free-Green`

**GitHub Actions cron** (`0 8 * * *`): not yet created.

**In Kit:** Create automations triggered by `Free-Green` tag → $497 invite sequence; `Free-Yellow` tag → nudge sequence.

## Edge Cases & Risk

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| skool-cli session cookie expires mid-run | L | M | `ensureSession()` re-auths before any reads; session check happens at startup |
| Skool Next.js build ID changes between page fetches | L | M | Build ID fetched once per run; mid-run changes would produce 404s caught as errors |
| Email mismatch (survey email ≠ Zapier email) | M | L | Sync writes email only if col G is empty; form bridge matches on col G |
| Sheet column order drifts | L | H | `MembersSheet` reads/writes by header index from `HEADER_ROW` constant — never by hard-coded column letter |
| Kit subscriber doesn't exist yet | M | L | Kit API upserts on email — `POST /subscribers` creates if absent |
| Segmentation tabs accumulate if pruning fails | L | L | Stale tabs are cosmetic only; prune runs again next day |
| `api.getCookies()` breaks on skool-cli internal refactor | M | H | Isolated to one call in `SkoolClient.fetchAllMembers()` — one-line fix if API changes |

## Acceptance Criteria

### Phase 1
- [ ] Sheet has exactly the 18 columns in specified order
- [ ] Activation Score formula returns correct count on 5 test rows
- [ ] Health Bucket formula returns Red/Yellow/Green correctly across boundary values (0, 1, 2, 3, 4)
- [ ] `Sync Log` tab exists (auto-created or manual)

### Phase 2 ✅
- [x] `pnpm skool-sync` runs locally (with Doppler secrets) without error
- [x] Running twice does not duplicate rows (upsert by Skool ID confirmed)
- [x] Sync Log entry written on each run with timestamp and member count
- [x] Email written on new rows; existing col G values never overwritten
- [x] Current Situation and Main Goal populated from survey JSON
- [ ] GitHub Actions workflow runs successfully on `workflow_dispatch` (pending)

### Phase 3
- [ ] Form submission with a known email updates the correct row within 30 seconds
- [ ] Submission with unknown email appends a warning to Sync Log and does not throw
- [ ] Activation Score and Health Bucket update automatically after form write

### Phase 4
- [x] Three dated tabs created after Apps Script run (or fewer if a bucket has 0 members)
- [x] Each row contains: Name, Email, Main Goal, Health Bucket, Activation Score, First Message
- [x] First Message written back to column Q in `Members`
- [x] Tabs older than 7 days deleted on each run
- [ ] Time-driven trigger confirmed active in Apps Script dashboard (pending manual `createDailyTrigger()` run)

### Phase 5 ✅
- [x] Non-purchaser with Health Bucket "Green" has tag `Free-Green` in Kit and no `Free-Red`/`Free-Yellow`
- [x] Bucket change on subsequent day removes old tag and applies new tag
- [x] Purchaser (col P = Y) has all three `Free-*` tags removed
- [x] Rows without email or valid bucket are skipped (not errored)
- [ ] GitHub Actions workflow runs at 8am UTC without error (pending)
