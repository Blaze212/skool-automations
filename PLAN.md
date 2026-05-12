# Fractional Advisory Automation — High-Level Plan

## Context

This repo (`skool-automations`) already houses the CareerSystems Skool chatbot automation. The fractional advisory workflows are a second set of automations being added to the same codebase, following the same patterns and stack.

**Dual purpose:**
1. Automate fulfillment for Barton's own Fractional Advisory clients
2. The platform becomes the reusable product offered to fractional clients when they land their own clients — making it R&D that pays for itself

---

## Guiding Principles

- **Module-first**: every integration (Drive, Gmail, Skool, Trello) is a standalone reusable module
- **Workflow = composition**: each automation is a sequence of module calls with a trigger
- **Everything runs in Edge Functions**: Skool API calls use raw fetch with stored cookies — no Playwright at runtime. Playwright only runs in a GitHub Actions cron to refresh cookies periodically
- **Doppler for all secrets**: no `.env` files in the repo, consistent with existing project pattern
- **Follow existing spec format**: new workflow specs live in `docs/specs/` following the same structure as `054-skool-chat-bot.md`

---

## Stack (existing, do not change)

| Layer | Tool |
|---|---|
| Runtime | TypeScript, `tsx`, Node.js |
| Package manager | pnpm |
| Secrets | Doppler |
| Database | Supabase (`internal_automations` schema) |
| Edge logic | Supabase Edge Functions (Deno) |
| Skool (runtime) | Raw `fetch` to `api2.skool.com` using stored cookies |
| Skool (auth refresh) | `skool-cli` v2.2.1 via GitHub Actions cron |
| Google APIs | `googleapis` npm package + service account |
| AI | `@anthropic-ai/sdk` |
| Scripts | `doppler run -- pnpm tsx scripts/[name].ts` |

---

## Repository Structure

```
skool-automations/
├── docs/
│   └── specs/
│       ├── 054-skool-chat-bot.md          ← existing
│       ├── 055-fractional-onboarding.md   ← next
│       ├── 056-offer-configurator.md      ← TBD
│       ├── 057-company-list.md            ← TBD
│       ├── 058-people-finder.md           ← TBD
│       ├── 059-value-add-asset.md         ← TBD
│       ├── 060-messages.md                ← TBD
│       └── completed/
├── scripts/
│   ├── chatbot-mvp.ts                     ← existing
│   ├── sync-workbook.ts                   ← existing
│   └── refresh-skool-cookies.ts           ← new: run via GitHub Actions cron
├── supabase/
│   ├── config.toml                        ← existing (update to expose internal_automations schema)
│   ├── migrations/
│   │   ├── 20260506000000_skool_knowledge.sql   ← existing
│   │   └── 20260601000000_fractional.sql        ← new: clients + workflow_runs
│   └── functions/
│       ├── webhook-skool/                 ← existing
│       └── fractional-onboarding-form-webhook/       ← new: receives Google Form POST
├── appscript/
│   └── form-webhook.js                    ← new: generic reusable trigger
├── forms/
│   └── onboarding-fields.md              ← documents Google Form fields
├── PLAN.md                                ← this file
└── package.json
```

---

## Architecture

### Trigger → Edge Function → done

Everything runs end-to-end in the Edge Function. Skool API calls use raw `fetch` with cookies stored as a Doppler secret — no Playwright at runtime. Playwright only runs on a schedule (GitHub Actions cron) to refresh those cookies.

```
[Google Form]  ←— Barton fills out when client is confirmed
      │
      │ auto-populates
      ▼
[Google Sheet]
      │
      │ onFormSubmit (Apps Script)
      ▼
[Supabase Edge Function: fractional-onboarding-form-webhook]
      │
      ├──→ Supabase DB              write client record, mark workflow running
      ├──→ Google Drive API         create folder, copy + rename workbook template
      ├──→ Gmail API                send welcome email
      ├──→ Trello API               create tracking card with links
      └──→ api2.skool.com (fetch)   find member by name, grant course access
                │
                └──→ Supabase DB    mark workflow complete (or failed)

[GitHub Actions cron — twice a week]
      │
      └──→ scripts/refresh-skool-cookies.ts
                │   (Playwright login → extract cookies)
                └──→ Doppler secret: SKOOL_COOKIES  ←— Edge Function reads this
```

### Apps Script (Generic — reused for all forms)

One script attached to the Google Sheet. Only `WEBHOOK_URL` changes per form via Script Properties — the code never changes.

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

---

## Database (adds to existing `internal_automations` schema)

### `internal_automations.fractional_clients`
Canonical record for every Fractional Advisory client.

| Column | Type | Notes |
|---|---|---|
| id | uuid | PK, default gen_random_uuid() |
| full_name | text | |
| drive_email | text | email used for Google Drive sharing |
| skool_email | text | email for Skool lookup (may differ from drive_email) |
| trello_card_id | text | populated post-onboarding |
| drive_folder_id | text | populated post-onboarding |
| workbook_doc_id | text | populated post-onboarding |
| skool_member_id | text | populated after Skool lookup |
| program_start_date | date | |
| notes | text | |
| created_at | timestamptz | default now() |

### `internal_automations.fractional_workflow_runs`
Tracks every workflow execution per client. Enables retries, auditing, status visibility.

| Column | Type | Notes |
|---|---|---|
| id | uuid | PK |
| client_id | uuid | FK → internal_automations.fractional_clients |
| workflow | text | e.g. `onboard`, `offer-configurator` |
| status | text | `pending` \| `running` \| `complete` \| `failed` |
| error | text | populated on failure |
| started_at | timestamptz | |
| completed_at | timestamptz | |

---

## Google Form — Onboarding

**5 fields:**
1. Client full name
2. Email for Google Drive sharing
3. Email for Skool (note: "leave blank if same as above")
4. Program start date
5. Notes (optional)

Responses sheet triggers the Apps Script webhook → Edge Function URL.

---

## Known IDs & Config

| Resource | Value |
|---|---|
| Google Drive parent folder | `1L9tPoCkyIsqzRTVdwxg0LfzW1EszsDSn` |
| Workbook template doc ID | `1UZGnCnJGBCGX6z31wxj94cVRUOZFnGhnesZOir44NDQ` |
| Trello board ID | `kPkBmPHb` |
| Trello template card ID | `7TLXJXkG` |
| Skool community slug | `career-systems` |
| Skool group ID | `1a0f19d9d9274b7db163fbaf242fdab0` |
| Skool course ID (Fractional Advisory) | `57877eaeabb442dc85d41a24d65bd183` |
| Skool classroom root ID | `0912b0a3` |

| Trello list (new cards) | "New Clients" |

**Still needed:**

---

## The Six Fractional Workflows

| # | Spec | Workflow | Time Saved | Key Modules | Where it runs |
|---|---|---|---|---|---|
| 1 | 055 | **Onboard Client** | 10 min | Drive, Gmail, Trello + Skool | Edge Fn |
| 2 | 056 | **Offer Configurator** | 10 min | Docs, Claude, Drive, Gmail | TBD |
| 3 | 057 | **Company List** | 10 min | Sheets, Claude, Drive | TBD |
| 4 | 058 | **People Finder** | 10 min | Sheets, Claude, Drive | TBD |
| 5 | 059 | **Value Add Asset** | 20 min | Docs, Claude, Drive, Gmail | TBD |
| 6 | 060 | **Messages** | 10 min | Docs, Sheets, Claude, Gmail | TBD |

Workflows 2–6 details to be documented by Barton before specs are written.

---

## New Env Vars (Doppler)

| Var | Purpose |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Already exists — reuse for Drive + Gmail |
| `TRELLO_API_KEY` | Trello REST API key |
| `TRELLO_TOKEN` | Trello user token |
| `TRELLO_BOARD_ID` | `kPkBmPHb` |
| `TRELLO_TEMPLATE_CARD_ID` | ID of the Fractional Advisory template card |
| `FRACTIONAL_DRIVE_FOLDER_ID` | `1L9tPoCkyIsqzRTVdwxg0LfzW1EszsDSn` |
| `FRACTIONAL_WORKBOOK_TEMPLATE_ID` | `1UZGnCnJGBCGX6z31wxj94cVRUOZFnGhnesZOir44NDQ` |
| `SKOOL_COURSE_ID` | `57877eaeabb442dc85d41a24d65bd183` — Fractional Advisory course |
| `SKOOL_GROUP_ID` | `1a0f19d9d9274b7db163fbaf242fdab0` — Career Systems group |
| `SKOOL_COOKIES` | JSON cookie array from skool-cli — refreshed by GitHub Actions cron |
| `SKOOL_GROUP_ID` | Career Systems group ID (resolved from slug `career-systems`) |

---

## Build Order

1. Update PLAN.md (this file) and get sign-off ← **here now**
2. Bring in `.claude` config / CLAUDE.md from other project ← **blocked: need path**
3. Discover Skool member lookup + course grant endpoints (run API discovery or inspect network)
4. Write spec `055-fractional-onboarding.md`
5. Add migration: `internal_automations.fractional_clients` + `internal_automations.fractional_workflow_runs`
6. Build shared modules: `drive.ts`, `gmail.ts`, `trello.ts`, `skool.ts`
7. Build `fractional-onboarding-form-webhook` Edge Function (composes all modules)
8. Build `scripts/refresh-skool-cookies.ts` + GitHub Actions workflow
9. Set up Google Form + Apps Script webhook
10. End-to-end test with a real client
11. Document workflows 2–6 and write specs 056–060
12. Build workflows 2–6

---

## Open Questions

- [ ] `.claude` config — copy from careersystems/workspace/.claude (mount folder to access)
- [ ] Skool member lookup: `getMembers` uses name search via `skool.com/${group}/-/members?q=` — confirm name search is sufficient or discover email search endpoint
- [x] Skool course grant: `POST /groups/{groupId}/update-member-course-permission` `{"member_id","grant":[courseId]}` ✓
- [x] Skool tier change: `POST /members/{memberId}/tier-overrides` `{"tier":"premium"}` ✓
- [x] Confirm: does onboarding require tier change AND course grant, or just course grant? → just course grant ✓
- [x] Schema: `internal_automations` ✓
- [x] GitHub Actions cron: twice a week ✓
- [ ] Workflows 2–6 step-by-step details (Barton to document)
