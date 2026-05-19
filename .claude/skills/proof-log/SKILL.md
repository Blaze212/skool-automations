---
name: proof-log
description: Process proof log screenshots from inbox — redact, analyze, upload to Drive, log to sheet, emit weekly summary. Trigger when the user says "run proof log", "process screenshots", or "proof log".
---

# Proof Log Pipeline

Processes all screenshots in `$PROOF_LOG_INBOX_DIR`:

1. Discovers all `.png` / `.jpg` / `.jpeg` files in the inbox
2. Spawns one sub-agent per image **in parallel** — each redacts and analyzes one screenshot
3. For each result: uploads original, redacted SVG, and final PNG to Drive; inserts row at top of sheet
4. Moves processed files to `$PROOF_LOG_DONE_DIR`
5. Emits a markdown summary

---

## Prerequisites

These secrets must be available (injected via `doppler run --`):

| Variable | Purpose |
|---|---|
| `PROOF_LOG_INBOX_DIR` | Local folder where raw screenshots are dropped |
| `PROOF_LOG_DONE_DIR` | Archive folder for processed files |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Google service account key |
| `PROOF_LOG_DRIVE_FOLDER_ID` | Root Drive folder containing `original/`, `redacted/`, `final/` |
| `PROOF_LOG_SHEET_ID` | Proof log Google Sheet ID |

Read these from the environment at the start. If any are missing, print a clear error and stop.

---

## Step 1 — Discover images

List all files in `$PROOF_LOG_INBOX_DIR` matching `*.png`, `*.jpg`, `*.jpeg` (case-insensitive).
Skip any file whose name already contains `-redacted` or `-final` (these are outputs, not inputs).

```bash
find "$PROOF_LOG_INBOX_DIR" -maxdepth 1 \( -iname "*.png" -o -iname "*.jpg" -o -iname "*.jpeg" \) \
  | grep -v -E '(-redacted|-final)\.' | sort
```

If the list is empty, print `No screenshots found in $PROOF_LOG_INBOX_DIR.` and stop.

Print: `Found N screenshot(s) to process.`

---

## Step 2 — Fan out (parallel sub-agents)

Spawn one Agent per image **simultaneously** — do not wait for one to finish before starting the next.

Each sub-agent receives the [Sub-agent prompt](#sub-agent-prompt) below with `{{IMAGE_PATH}}` replaced by the absolute path to that image.

Wait for **all** sub-agents to complete before continuing. Each returns a JSON string (the analysis result). Collect results in the same order as the image list. If a sub-agent fails or returns malformed JSON, log the filename and error, then continue with the remaining results — do not abort the whole run.

---

## Step 3 — Upload and log (sequential, one image at a time)

For each successful sub-agent result:

Parse the JSON. Then run the four commands below in order. Capture stdout from each upload call — that is the Drive `webViewLink`.

```bash
# 1. Upload original screenshot
ORIGINAL_LINK=$(doppler run -- tsx automations/proof-log/drive-uploader.ts "{{IMAGE_PATH}}" original)

# 2. Upload redacted SVG (editable)
REDACTED_LINK=$(doppler run -- tsx automations/proof-log/drive-uploader.ts "{{SVG_PATH}}" redacted)

# 3. Upload final PNG (flat)
FINAL_LINK=$(doppler run -- tsx automations/proof-log/drive-uploader.ts "{{FINAL_PATH}}" final)

# 4. Insert row at top of sheet
doppler run -- tsx automations/proof-log/sheets-updater.ts '{{ROW_JSON}}'
```

`{{ROW_JSON}}` is the full `ProofLogRow` object as a JSON string, with `screenshotLink`, `redactedLink`, and `finalLink` filled in from the three upload links above. All other fields come from the sub-agent analysis JSON.

`ProofLogRow` shape (all fields required; use empty string for any field the sub-agent left blank):

```json
{
  "date": "YYYY-MM-DD or empty string",
  "screenshotLink": "<ORIGINAL_LINK>",
  "redactedLink": "<REDACTED_LINK>",
  "finalLink": "<FINAL_LINK>",
  "area": "...",
  "level": "...",
  "function": "...",
  "status": "...",
  "trigger": "...",
  "behavior": "...",
  "outcome": "...",
  "friction": "...",
  "artifacts": "...",
  "mainObjection": "..."
}
```

If any upload fails (non-zero exit), log the error and skip the sheet insert for that image. Continue with the next image.

---

## Step 4 — Move processed files

After all uploads complete, move each successfully processed original to `$PROOF_LOG_DONE_DIR`:

```bash
mv "{{IMAGE_PATH}}" "$PROOF_LOG_DONE_DIR/"
```

Move the temp SVG and PNG from `/tmp/proof-log/{{BASE}}/` to `$PROOF_LOG_DONE_DIR/redacted/`:

```bash
mkdir -p "$PROOF_LOG_DONE_DIR/redacted"
mv "/tmp/proof-log/{{BASE}}/{{BASE}}.svg" "$PROOF_LOG_DONE_DIR/redacted/"
mv "/tmp/proof-log/{{BASE}}/{{BASE}}.png" "$PROOF_LOG_DONE_DIR/redacted/"
```

Leave failed images in the inbox untouched.

---

## Step 5 — Emit summary

Print to stdout:

```
## Proof Log Run — YYYY-MM-DD
Processed: N of M screenshots

By Area:     Outreach (3), Offer (2), Mindset (1)
By Level:    IC (4), Leader (2)
By Function: Program (2), HR (2), Strat & Ops (1), Sales (1)
By Status:   Laid off (4), Employed (1), Fractional (1)

Entries:
- [<title from trigger, first sentence>] — <area> / <level> / <function> / <status>
- ...

Sheet: https://docs.google.com/spreadsheets/d/<PROOF_LOG_SHEET_ID>

Skipped (errors): <filenames, or "none">
```

---

## Sub-agent prompt

Use this prompt verbatim for each sub-agent, substituting `{{IMAGE_PATH}}` with the absolute file path.

---

```
You are processing one proof log screenshot. Complete both steps and return only the final JSON.

## Image path
{{IMAGE_PATH}}

---

## Step 1 — Redact

Invoke the `redact-skool-screenshots` skill on this image.

After the skill completes, its outputs are at:
- `.claude/skills/redact-skool-screenshots/outputs/skool-redacted.svg`
- `.claude/skills/redact-skool-screenshots/outputs/skool-redacted.png`

Determine the base name of the input image (filename without extension).
Example: if IMAGE_PATH is `/inbox/boeing-win.png`, base name is `boeing-win`.

Copy the outputs to a temp directory with the base name so `drive-uploader.ts` can apply postfixes correctly:

```bash
BASE="<base name>"
mkdir -p "/tmp/proof-log/$BASE"
cp .claude/skills/redact-skool-screenshots/outputs/skool-redacted.svg "/tmp/proof-log/$BASE/$BASE.svg"
cp .claude/skills/redact-skool-screenshots/outputs/skool-redacted.png "/tmp/proof-log/$BASE/$BASE.png"
```

---

## Step 2 — Analyze

Read `{{IMAGE_PATH}}` and extract the fields below.

### Label enumerations (use exact strings)

- **area**: `Target` | `Resume` | `Outreach` | `Interview` | `Negotiation` | `Offer` | `Mindset`
- **level**: `IC` | `Leader` | `Executive` | `Fractional`
- **function**: `CS` | `Data` | `Finance` | `HR` | `IT` | `Marketing` | `Product` | `Program` | `Sales` | `Strat & Ops` | `UX`
- **status**: `Laid off` | `Employed` | `Fractional`

### Label guidance

- **area**: Primary topic. Outreach = networking/messages sent. Offer = received or accepted offer. Interview = interview secured or completed. Resume = resume win. Target = clarity/targeting win. Negotiation = salary/terms. Mindset = emotional breakthrough or shift.
- **level**: IC = individual contributor (no direct reports). Leader = manager or director. Executive = VP or C-suite. Fractional = fractional or consulting role.
- **function**: Infer from the person's role, industry, or job title mentioned in the post.
- **status**: Laid off = recently laid off. Employed = currently employed while searching. Fractional = working as fractional/consultant.
- **mainObjection**: Only populate if the person explicitly stated a belief they held before this win (e.g. "I thought cold outreach wouldn't work", "I didn't think my network would help"). Leave empty string if no explicit objection is stated.

### Few-shot example

**Post text:** "A mini-win! (3 interviews in 1 week) After getting laid off 2 months ago + spending 20+ years at Boeing... I sent 8 cold connection requests (0 accepted). But I also sent 68 gratitude messages to past Boeing managers. Spent the week catching up with 19 of them. 3 immediately asked me to interview for their team. Each job pays $40k–$70k more than Boeing. None of them even knew I was laid off — people aren't unwilling to help, they just don't know you need it."

**Expected output:**
```json
{
  "base": "boeing-win",
  "svgPath": "/tmp/proof-log/boeing-win/boeing-win.svg",
  "finalPath": "/tmp/proof-log/boeing-win/boeing-win.png",
  "date": "",
  "area": "Outreach",
  "level": "IC",
  "function": "Program",
  "status": "Laid off",
  "trigger": "Laid off 2 months ago after 20+ years at Boeing, dealing with family issues, and finally deciding to start structured outreach 1.5 weeks prior.",
  "behavior": "• Sent 8 cold LinkedIn connection requests (0 accepted)\n• Sent 68 gratitude messages to past Boeing managers and colleagues\n• Spent the week on calls catching up with 19 former colleagues",
  "outcome": "• 3 former managers immediately asked them to interview for their specific teams\n• One manager said the interview is a formality — would skip it and give the offer directly\n• All 3 roles pay $40k–$70k more than Boeing comp\n• Realization: network is willing to help once they know you need it",
  "friction": "Emotional drag from layoff, 20+ years at one company, family issues, and seeing 0 accepts on cold outreach. Surprise: warm gratitude messages to existing network produced 3 high-paying interviews within a week.",
  "artifacts": "68-message gratitude outreach template: short personal update + thanks + what you're looking for. Micro-SOP: turn old colleagues into new interviews — what to say, how to ask for nothing and still unlock help.",
  "mainObjection": ""
}
```

---

## Output

Return ONLY the JSON object below — no prose, no markdown fences, no explanation.

```json
{
  "base": "<filename without extension>",
  "svgPath": "/tmp/proof-log/<base>/<base>.svg",
  "finalPath": "/tmp/proof-log/<base>/<base>.png",
  "date": "<YYYY-MM-DD visible in post, or empty string>",
  "area": "<one of the area values>",
  "level": "<one of the level values>",
  "function": "<one of the function values>",
  "status": "<one of the status values>",
  "trigger": "<1–2 sentences: what prompted them to act or share>",
  "behavior": "<bulleted list as single string, each bullet starting with •>",
  "outcome": "<bulleted list as single string, each bullet starting with •>",
  "friction": "<what was emotionally hard, then what was surprising — single paragraph>",
  "artifacts": "<templates or SOPs worth capturing; empty string if none>",
  "mainObjection": "<explicit skepticism stated before the win; empty string if not stated>"
}
```
```

---

## Error handling

- **Sub-agent returns no output or non-JSON**: log `[SKIP] <filename>: sub-agent returned no parseable JSON` and continue.
- **Upload fails (non-zero exit)**: log `[SKIP] <filename>: upload failed — <stderr>` and skip the sheet insert. Leave the file in inbox.
- **Sheet insert fails**: log `[WARN] <filename>: sheet insert failed — <stderr>`. The Drive files are already uploaded; note the Drive links in the log so the row can be added manually.
- **Redact skill fails after 3 retries**: log `[SKIP] <filename>: redaction failed` and skip the image entirely. Leave it in inbox.
