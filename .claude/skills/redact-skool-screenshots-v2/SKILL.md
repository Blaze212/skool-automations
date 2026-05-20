---
name: redact-skool-screenshots-v2
description: Batch-process Skool screenshots into proof log entries. Auto-discovers images from an inbox folder, redacts names/avatars/@mentions in parallel using Haiku subagents, extracts win data using the proof log template, uploads PNG (-final) and SVG (-editable) to Google Drive, and appends structured rows with hyperlinks to the proof spreadsheet. Trigger on "proof log", "process screenshots", "redact batch", "log wins", or any mention of the Skool win-capture workflow. Also trigger when the user drops screenshots into the inbox and wants them processed.
---

# Redact Skool Screenshots v2

**Architecture:** one orchestrating agent + one Haiku subagent per image, all running in parallel. The orchestrator handles config, discovery, sheet updates, and cleanup. Each subagent handles one image: redact → extract proof data → upload to Drive → return results.

**Skill base dir** is shown in the header when the skill loads. All `python3 scripts/...` commands must run from `<skill-dir>`. Each subagent gets its own output directory at `<skill-dir>/outputs/<slug>/`.

---

## Step 0 — Read config

```bash
cat ~/.config/skool-automations/proof-log.json 2>/dev/null || echo "NOT FOUND"
```

Required keys:

```json
{
  "inboxDir": "/path/to/to-redact",
  "doneDir": "/path/to/completed",
  "driveFolderId": "<Google Drive folder ID>",
  "sheetId": "<Google Sheet ID>"
}
```

If any key is missing, ask the user then write the complete file to `~/.config/skool-automations/proof-log.json`. `GOOGLE_SERVICE_ACCOUNT_JSON` comes from Doppler — no config entry needed.

---

## Step 1 — Discover images and load URL index

```bash
python3 -c "
import os, json
cfg = json.load(open(os.path.expanduser('~/.config/skool-automations/proof-log.json')))
inbox = cfg['inboxDir']
files = sorted(f for f in os.listdir(inbox) if f.lower().endswith(('.png','.jpg','.jpeg')))
# Load URL index if present
idx_path = os.path.join(inbox, 'url_index.json')
url_map = {}
if os.path.exists(idx_path):
    idx = json.load(open(idx_path))
    url_map = {s['filename']: s['url'] for s in idx.get('screenshots', [])}
for f in files:
    url = url_map.get(f, 'NOT FOUND')
    print(f'{f}  →  {url}')
"
```

Show the list to the user — including any files whose URL is NOT FOUND — and confirm before proceeding.

Build a `filename → post_url` map from `url_index.json` for use in Step 2. If a file has no matching entry, `POST_URL` for that subagent is `""` (empty string); note it in the final summary.

If the inbox is empty, run:

```bash
cd <skill-dir> && python3 scripts/extract_latest_screenshot.py outputs/
```

and use whatever it finds. If still nothing, ask the user to drop files into the inbox or attach them.

---

## Step 2 — Spawn parallel Haiku subagents

**One Agent tool call. All subagents in the same message. Model: haiku.**

For each image, compute:
- `SLUG` — `pathlib.Path(filename).stem` with spaces/unicode replaced by `-`, e.g. `Screenshot-2026-05-20-at-11.56.10-AM`
- `OUTPUT_DIR` — `<skill-dir>/outputs/<SLUG>/`
- `POST_URL` — from the url_index.json map (empty string if not found)

Use the subagent template below, filling in all `<PLACEHOLDER>` values.

---

### ── SUBAGENT TEMPLATE (copy verbatim, fill placeholders) ──

```
You are processing one Skool screenshot as part of the proof log pipeline.

IMAGE_PATH:      <absolute path to image>
SLUG:            <sanitized stem>
OUTPUT_DIR:      <skill-dir>/outputs/<slug>/
SKILL_DIR:       <skill-dir>
POST_URL:        <url from url_index.json, or empty string>
DRIVE_FOLDER_ID: <from config>
SHEET_ID:        <from config>

GOOGLE_SERVICE_ACCOUNT_JSON is in the environment — prefix every script call with:
  doppler run --

---

### A — Setup

Create the output directory:
```bash
mkdir -p OUTPUT_DIR
```

---

### B — Pixel-scan redaction spec

```bash
cd SKILL_DIR && python3 scripts/build_spec.py IMAGE_PATH OUTPUT_DIR/spec.json
```

Review the printed counts. Then check for missed @mentions in the post body — run:

```bash
cd SKILL_DIR && python3 scripts/find_blue_pixels.py IMAGE_PATH 80
```

This prints a JSON array of `[x0, y0, x1, y1]` boxes for every blue hyperlink cluster below y=80. Compare against the regions already in spec.json. For any blue cluster NOT already covered by an existing region, add a custom region:

```json
{ "type": "custom", "label": "@Name (mention)", "bbox": [x0, y0, x1, y1] }
```

---

### C — Add labels (vision pass)

Read IMAGE_PATH visually. In OUTPUT_DIR/spec.json, replace every `"Person N — add label"` string with the real name. Do NOT touch any coordinates.

---

### D — Render

```bash
cd SKILL_DIR
python3 scripts/build_svg.py IMAGE_PATH OUTPUT_DIR/spec.json OUTPUT_DIR/redacted-editable.svg
python3 scripts/render_redactions.py IMAGE_PATH OUTPUT_DIR/redacted-final.png OUTPUT_DIR/spec.json
```

---

### E — Verify (max 3 attempts)

```bash
cd SKILL_DIR && python3 scripts/verify_redactions.py IMAGE_PATH OUTPUT_DIR/redacted-final.png OUTPUT_DIR/spec.json
```

If any check fails: fix spec.json → re-render (step D) → re-verify. Max 3 attempts. If still failing after 3, continue with a ⚠️ warning noting which checks failed.

---

### F — Visual check

Read OUTPUT_DIR/redacted-final.png. Confirm:
- Every avatar is fully covered.
- Every author name is covered; timestamp visible to its right.
- Every @mention is covered including the `@` symbol.
- Post title, body text, and UI chrome are intact.

---

### G — Extract proof data

Read IMAGE_PATH (the ORIGINAL, unredacted image) visually. Extract the post content and fill in this JSON — infer from the post text:

```json
{
  "title": "<area> Win - <short topic or poster's first name, e.g. 'Outreach Win - Rosh' or 'Mindset Win - Groundhog Day'>",
  "post_text": "full verbatim text of the post — include all paragraphs, preserve line breaks as \\n",
  "area": "Resume | Outreach | Interview | Negotiation | Mindset",
  "level": "IC | Manager | Director | VP | Fractional",
  "function": "Product | Ops | HR | Marketing | Finance | Other",
  "status": "Laid off | Employed | Fractional pivot",
  "main_objection": "Price | Time | I should know this already | Too introverted | My case is different | Unknown",
  "trigger": "what changed — one sentence",
  "behavior": "what they did — one sentence",
  "outcome": "result with numbers if present — one sentence",
  "friction_surprise": "what was unexpected or hard",
  "artifact_candidate": "what could be reused as social proof"
}
```

Rules:
- Use "Unknown" or "N/A" for fields you genuinely cannot infer.
- Quote numbers directly from the post in `outcome` where they appear.
- Keep each field to 1–2 sentences maximum.

---

### H — Upload all 3 files to Drive

Use the `title` from step G as the Drive filename base. Sanitize it for filenames: replace `/` and `:` with `-`, strip leading/trailing spaces.

```bash
# Original (unredacted) — no postfix
doppler run -- python3 SKILL_DIR/scripts/upload_to_drive.py \
  IMAGE_PATH \
  "<title>.png" \
  DRIVE_FOLDER_ID
```

Capture stdout as `ORIGINAL_URL`.

```bash
# Redacted PNG
doppler run -- python3 SKILL_DIR/scripts/upload_to_drive.py \
  OUTPUT_DIR/redacted-final.png \
  "<title>-final.png" \
  DRIVE_FOLDER_ID
```

Capture stdout as `PNG_URL`.

```bash
# Editable SVG
doppler run -- python3 SKILL_DIR/scripts/upload_to_drive.py \
  OUTPUT_DIR/redacted-editable.svg \
  "<title>-editable.svg" \
  DRIVE_FOLDER_ID
```

Capture stdout as `SVG_URL`.

---

### I — Return result

Print this exact JSON block as the LAST thing you output (the orchestrator reads it):

```json
{
  "slug": "SLUG",
  "post_url": "POST_URL",
  "original_url": "<ORIGINAL_URL>",
  "png_url": "<PNG_URL>",
  "svg_url": "<SVG_URL>",
  "warnings": ["list any issues: missing fields, verify failures, etc. Empty array if clean."],
  "proof": {
    "title": "...",
    "post_text": "...",
    "area": "...",
    "level": "...",
    "function": "...",
    "status": "...",
    "main_objection": "...",
    "trigger": "...",
    "behavior": "...",
    "outcome": "...",
    "friction_surprise": "...",
    "artifact_candidate": "..."
  }
}
```
```

---

## Step 3 — Collect results and update the sheet

After all subagents complete, parse the result JSON from each subagent's final output. For each result, run:

```bash
doppler run -- python3 <skill-dir>/scripts/append_sheet_row.py \
  "<sheetId from config>" \
  '<JSON object with all proof fields + png_url + svg_url + date (today ISO)>'
```

The JSON object passed to `append_sheet_row.py` must include all 17 keys:
`date, post_url, title, area, level, function, status, main_objection, trigger, behavior, outcome, friction_surprise, artifact_candidate, post_text, original_url, png_url, svg_url`

`date` must be formatted as `MM/DD/YYYY`. The script renders it as `=HYPERLINK(post_url,"MM/DD/YYYY")` — or plain text if `post_url` is empty.

Sheet columns (Overview!A:P):
`Date | Title | Area | Level | Function | Status | Main Objection | Trigger | Behavior | Outcome | Friction/Surprise | Artifact Candidate | Post Text | Original | PNG | SVG`

Date, Original, PNG, and SVG cells are written as `=HYPERLINK()` formulas by the script.

---

## Step 4 — Move originals to done

```bash
python3 -c "
import os, shutil, json
cfg = json.load(open(os.path.expanduser('~/.config/skool-automations/proof-log.json')))
originals = <list of original file absolute paths>
for p in originals:
    shutil.move(p, cfg['doneDir'])
    print('Moved:', os.path.basename(p))
"
```

---

## Step 5 — Summary report

After moving files, print a summary table to the user. One row per image:

```
✅ Outreach Win - Rosh          → sheet row added, all 3 files uploaded
⚠️  Mindset Win - Groundhog Day → sheet row added, verify FAIL on name bbox (check SVG)
❌  screenshot_20260520_xyz.png  → Drive upload failed: [error message]
```

Use ✅ for fully clean, ⚠️ for completed with warnings, ❌ for hard failures.

After the table, list any items needing user action:
- Files with no `post_url` in url_index.json (sheet Date cell is plain text, not a hyperlink)
- Proof fields that defaulted to "Unknown" or "N/A" (area, level, function, etc.)
- Verify failures that weren't fully resolved (name which check failed and which SVG to open)
- Any Drive or sheet errors

If everything is clean, just say so. Keep it tight — one line per issue.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Avatar not covered | Increase `r` in spec.json by 3–5 px and re-render |
| Name not covered | Increase `name_bbox x1` in spec.json by 5–8 px |
| @mention missed | Run `find_blue_pixels.py` to get actual coords; add a `custom` region |
| Drive 404 | `supportsAllDrives=True` is already set; check the service account has Editor access to the folder |
| Sheet "Unable to parse range" | The tab isn't named Overview — check the actual sheet tab name |
| JWT `invalid_grant` | Sandbox clock skew — fix with: `sudo date -s "$(python3 -c "import subprocess,re; r=subprocess.run(['curl','-sI','https://www.googleapis.com'],capture_output=True,text=True); m=re.search(r'(?i)date: (.+)',r.stdout); from datetime import datetime,timedelta; dt=datetime.strptime(m.group(1).strip(),'%a, %d %b %Y %H:%M:%S %Z'); print((dt-timedelta(hours=5)).strftime('%Y-%m-%d %H:%M:%S'))")"` |
| `google-api-python-client` missing | All three new scripts auto-install it on first run |

---

## Bundled scripts

| Script | Purpose |
|--------|---------|
| `build_spec.py` | Pixel-scans for avatars, names, @mentions; writes spec.json |
| `build_svg.py` | Generates layered SVG (each rect is a named, editable object) |
| `render_redactions.py` | Renders teal blocks from spec to PNG |
| `verify_redactions.py` | Coverage and overcoverage checks |
| `find_blue_pixels.py` | Finds @mention blue-pixel bounding boxes anywhere in the image |
| `extract_latest_screenshot.py` | Extracts inline-pasted screenshots from session transcript |
| `upload_to_drive.py` | Uploads one file to Drive; returns webViewLink |
| `append_sheet_row.py` | Appends one proof log row (with HYPERLINK formulas) to Overview sheet |
