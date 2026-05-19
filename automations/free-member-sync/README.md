# free-member-sync

Two scripts that keep the free-member CRM Google Sheet in sync with Skool and Kit.

| Script       | What it does                                                                                                   |
| ------------ | -------------------------------------------------------------------------------------------------------------- |
| `skool-sync` | Fetches all Skool members and upserts them into the **Members** tab                                            |
| `kit-sync`   | Reads the sheet and syncs each member's `Health Bucket` to a Kit tag (`Free-Red`, `Free-Yellow`, `Free-Green`) |

Both scripts append a row to the **Sync Log** tab on every run.

---

## Prerequisites

- Node.js 20+
- [Doppler CLI](https://docs.doppler.com/docs/install-cli) authenticated to this project
- A Google service account with **Editor** access to the sheet
- A `skool-cli` auth state file (created by running `skool login` once)

---

## Required secrets (managed in Doppler)

| Secret                            | Used by    | Description                                                |
| --------------------------------- | ---------- | ---------------------------------------------------------- |
| `SKOOL_EMAIL`                     | skool-sync | Skool login email                                          |
| `SKOOL_PASSWORD`                  | skool-sync | Skool login password                                       |
| `SKOOL_CLI_DATA_DIR`              | skool-sync | Path to skool-cli data directory (default: `~/.skool-cli`) |
| `GOOGLE_SERVICE_ACCOUNT_JSON`     | both       | Full JSON of the Google service account key                |
| `SKOOL_FREE_MEMBER_SYNC_SHEET_ID` | both       | Google Sheet ID (the long string in the sheet URL)         |
| `KIT_API_KEY`                     | kit-sync   | Kit (ConvertKit) v4 API key                                |

---

## First-time setup

1. **Install dependencies** (from repo root):

   ```bash
   pnpm install
   ```

2. **Authenticate skool-cli** (one-time, on the machine that will run the scripts):

   ```bash
   npx skool login
   ```

   This writes an `auth-state.json` session cookie to `SKOOL_CLI_DATA_DIR` (default `~/.skool-cli`). The session is reused on subsequent runs; the script re-logs in automatically if it expires.

3. **Configure Doppler** (from repo root):

   ```bash
   doppler setup
   ```

   Verify secrets are available:

   ```bash
   doppler secrets
   ```

---

## Running

```bash
# From repo root
pnpm skool-sync   # fetch Skool members → upsert into sheet
pnpm kit-sync     # read sheet → sync Kit tags
```

These expand to:

```bash
doppler run -- tsx automations/free-member-sync/skool-sync.ts
doppler run -- tsx automations/free-member-sync/kit-sync.ts
```

Run them in order: `skool-sync` first so the sheet is up to date before `kit-sync` reads it.

---

## Sheet structure

### Members tab

Columns A–R are managed by these scripts. Column G (Email) is owned by Zapier — the scripts will write it only if the cell is empty and will never overwrite an existing value.

| Col | Header                      | Written by                                        |
| --- | --------------------------- | ------------------------------------------------- |
| A   | Name                        | skool-sync                                        |
| B   | Skool Id                    | skool-sync                                        |
| C   | Join Date                   | skool-sync                                        |
| D   | Last Login Date             | skool-sync                                        |
| E   | Current Situation           | skool-sync                                        |
| F   | Main Goal                   | skool-sync                                        |
| G   | Email                       | Zapier (skool-sync fills if empty)                |
| H–N | Roadmap … DM/Email Response | Manual                                            |
| O   | Health Bucket               | Manual (`Red` / `Yellow` / `Green`)               |
| P   | Purchase/Scholarship        | Manual (`Y` = purchased; clears all Free-\* tags) |
| Q–R | First Message, Notes        | Manual                                            |

### Sync Log tab

Each run appends one row: `timestamp`, `event`, `status`, `detail`.

---

## Apps Script — daily segmentation

The `appscripts/` folder contains the Google Apps Script that runs daily segmentation on the sheet.

### Files

| File              | Purpose                                                       |
| ----------------- | ------------------------------------------------------------- |
| `segmentation.gs` | Main script — `runDailySegmentation()` and `onEdit()` trigger |
| `appsscript.json` | Apps Script manifest (runtime, OAuth scopes, timezone)        |
| `.clasp.json`     | Clasp config — points to the sheet-bound script project       |

### How it works

- **`runDailySegmentation()`** — reads non-purchaser Members rows where col Q (First Message) is empty, groups them by Health Bucket, and creates dated tabs `Red_YYYYMMDD` / `Yellow_YYYYMMDD` / `Green_YYYYMMDD` with a Y/N Sent dropdown. Prunes tabs older than 7 days.
- **`onEdit()`** — fires automatically on every sheet edit. When you set Sent = Y on a row in a segmentation tab, it writes `{Bucket} DM` to col Q in Members for that person.
- **`createDailyTrigger()`** — run once to install a 5pm daily time-driven trigger. Idempotent.

### Deploying changes with clasp

Install clasp globally if you haven't already:

```bash
npm install -g @google/clasp
```

Log in (opens a browser):

```bash
clasp login
```

Push the local script to Google:

```bash
cd automations/free-member-sync/appscripts
clasp push
```

Clasp reads `.clasp.json` to find the target script project. The `--force` flag skips the confirmation prompt if you want to overwrite without being asked.

### First-time trigger setup

After pushing, open the script in the Apps Script editor and run `createDailyTrigger()` once from the editor toolbar. This installs the 5pm daily trigger. You can confirm it's active under **Triggers** (clock icon) in the left sidebar.

---

## Cron / automation

To run on a schedule, add a cron job or GitHub Actions workflow that calls:

```bash
doppler run --project <project> --config <config> -- tsx automations/free-member-sync/skool-sync.ts
doppler run --project <project> --config <config> -- tsx automations/free-member-sync/kit-sync.ts
```
