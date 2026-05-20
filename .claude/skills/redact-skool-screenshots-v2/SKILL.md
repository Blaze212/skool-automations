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

### G — Extract proof data (two steps)

**G1 — Transcribe post text (vision pass)**

Read IMAGE_PATH visually. Transcribe the full verbatim text of the post — all paragraphs, preserve line breaks as `\n`. Include post title if visible. Store as `POST_TEXT`.

Also generate a friendly title for the Drive filenames:
`<area> Win - <poster's first name or short topic>` e.g. `Outreach Win - Rosh` or `Mindset Win - Groundhog Day`.
Store as `FRIENDLY_TITLE`.

**G2 — Run proof extraction prompt**

Pass the transcribed text to the standalone extraction script:

```bash
PROOF_JSON=$(doppler run -- python3 SKILL_DIR/scripts/extract_proof_data.py "$POST_TEXT")
echo "$PROOF_JSON"
```

The script calls Claude Haiku with the proof log template and returns a JSON object with these fields:
`area, level, function, status, main_objection, trigger, behavior, outcome, friction_surprise, artifact_candidate`

If the script exits non-zero, note it in the `warnings` array and proceed with empty proof fields.

---

### H — Upload all 3 files to Drive

Use `FRIENDLY_TITLE` from step G1 as the Drive filename base. Sanitize: replace `/` and `:` with `-`, strip leading/trailing spaces.

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
  "source_filename": "<original filename in inbox, e.g. screenshot_20260520_131303.png>",
  "post_url": "POST_URL",
  "original_filename": "<FRIENDLY_TITLE>.png",
  "png_filename": "<FRIENDLY_TITLE>-final.png",
  "svg_filename": "<FRIENDLY_TITLE>-editable.svg",
  "original_url": "<ORIGINAL_URL>",
  "png_url": "<PNG_URL>",
  "svg_url": "<SVG_URL>",
  "warnings": ["list any issues: missing fields, verify failures, etc. Empty array if clean."],
  "proof": {
    "title": "FRIENDLY_TITLE",
    "post_text": "POST_TEXT",
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

The JSON object passed to `append_sheet_row.py` must include:
`date, post_url, title, original_filename, png_filename, svg_filename, area, level, function, status, main_objection, trigger, behavior, outcome, friction_surprise, artifact_candidate, post_text, original_url, png_url, svg_url`

`date` must be formatted as `MM/DD/YYYY`. `title` is used to derive filenames if the explicit filename fields are missing. The three `*_filename` fields are used as the visible link text in the sheet (e.g. `Outreach Win - Rosh.png`) so Drive files are searchable by name.

**The script reads the actual header row of the Overview tab and matches values to columns by name — column order does not matter.** Column names it recognises (case-insensitive, punctuation-stripped):

| Sheet column header | Value source |
|---|---|
| Date | `=HYPERLINK(post_url,"MM/DD/YYYY")` or plain text |
| Screenshot | `=HYPERLINK(original_url,"View Original")` |
| Redacted PNG | `=HYPERLINK(png_url,"View PNG")` |
| Redacted SVG (Editable) | `=HYPERLINK(svg_url,"View SVG")` |
| Area | `area` |
| Level | `level` |
| Function | `function` |
| Status | `status` |
| Trigger | `trigger` |
| Behavior | `behavior` |
| Outcome | `outcome` |
| Friction/Surprise | `friction_surprise` |
| Artifacts | `artifact_candidate` |
| Main Objection | `main_objection` |
| Post Text | `post_text` |

Any column in the sheet not in this list is left blank. Adding or reordering columns in the sheet requires no code changes.

---

## Step 4 — Move, rename, and update the index

For each processed image, rename it to its `original_filename` (the friendly Drive name) when moving to done, and update `url_index.json` so the mapping stays accurate.

```bash
python3 << 'EOF'
import os, shutil, json

cfg = json.load(open(os.path.expanduser('~/.config/skool-automations/proof-log.json')))
inbox   = cfg['inboxDir']
done    = cfg['doneDir']
idx_path = os.path.join(inbox, 'url_index.json')

# results = list of dicts from subagent outputs, each with:
#   source_filename, original_filename
results = <list of subagent result dicts>

# Load index (may not exist if inbox had no url_index.json)
if os.path.exists(idx_path):
    idx = json.load(open(idx_path))
    screenshots = idx.get('screenshots', [])
else:
    idx = {'screenshots': []}
    screenshots = []

for r in results:
    src  = os.path.join(inbox, r['source_filename'])
    dest = os.path.join(done,  r['original_filename'])
    if os.path.exists(src):
        shutil.move(src, dest)
        print(f"Moved: {r['source_filename']} → {r['original_filename']}")
    else:
        print(f"WARN: source not found: {src}")

    # Update the index entry
    for entry in screenshots:
        if entry.get('filename') == r['source_filename']:
            entry['filename'] = r['original_filename']
            break

# Write updated index back to inbox
with open(idx_path, 'w') as f:
    json.dump(idx, f, indent=2)
print("url_index.json updated")
EOF
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
| `extract_proof_data.py` | Calls Claude Haiku with the proof log template; returns structured JSON from post text |
| `upload_to_drive.py` | Uploads one file to Drive; returns webViewLink |
| `append_sheet_row.py` | Reads header row, matches columns by name, appends proof log row with HYPERLINK formulas |
