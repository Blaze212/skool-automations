---
name: redact-skool-screenshots
description: Redact Skool screenshot — cover names, avatars, and @mentions with teal rounded rectangles using pixel-scan (not visual estimates). Trigger when user shares a Skool screenshot and asks to redact or anonymize names/people. Also trigger on any request to blur, hide, censor, or remove identities from a Skool community screenshot.
---

# Redact Skool Screenshot (pixel-scan → render → verify)

Cover names, avatars, and @mentions in a Skool screenshot with dark-teal rounded rectangles.

**Core principle:** coordinates must NEVER be estimated. Screenshots vary in length depending on how many comments exist and how long each comment body is. Claude's visual coordinate estimates are unreliable; even small errors compound through calibration. Instead, `build_spec.py` scans the actual pixels and derives every bounding box from what is literally in the image. Claude's only job is to add labels.

## What to redact

Cover these with teal rounded rectangles (`#1F3E3E`):

- Each post/comment author's **avatar circle**.
- Each post/comment author's **name** — the bold text to the right of the avatar. Stop before the `·` separator so timestamps stay visible.
- Each **@mention** in body text — the full `@FirstName LastName` string including the `@`. Adjacent mentions on one line are merged into a single block.

## What to leave visible

- Post titles — topic, not a person.
- Community / category icons in the post header.
- `Xd`/`Xh`/`Xm`/`Xw` timestamps to the right of redacted names.
- `See more`, `Like`, `Reply`, `N comments` and other UI chrome.
- Generic first-name references without `@` (e.g. "Hi Nicole").
- All post and comment body text.
- Add `"type": "custom"` regions if the user explicitly wants additional blocks.

---

## Important agent notes

- **Use Haiku model** — this skill is optimized for Claude Haiku. Run it with Haiku if possible for faster iteration on pixel-scanning and validation loops.
- **Working directory** — all `python3 scripts/...` commands must be run from `<skill-dir>` (the base directory shown at skill load time). Use `cd <skill-dir>` before any script command.
- **Do not rewrite script files** — if validation fails, only edit the `spec.json` file. Never modify `build_spec.py`, `render_redactions.py`, `verify_redactions.py`, or any other script. Use the Edit tool to adjust bounding boxes in the spec instead.
- **Always output fully qualified paths** — when presenting images, provide absolute file paths (e.g. `<skill-dir>/outputs/skool-redacted.png`, not relative paths).

## Workflow

### Step 0 — Check proof log config (ALWAYS first)

Before asking for the screenshot, check whether the config file is present and complete:

```bash
cat ~/.config/skool-automations/proof-log.json 2>/dev/null || echo "NOT FOUND"
```

If the file is missing **or any key is absent**, ask the user for the missing value(s) now, then write the complete file with the Write tool at `~/.config/skool-automations/proof-log.json` before continuing:

```json
{
  "inboxDir": "/Users/barton/proof-log/inbox",
  "doneDir": "/Users/barton/proof-log/done",
  "driveFolderId": "<Google Drive folder ID>",
  "sheetId": "<Google Sheet ID>"
}
```

Key | What to ask the user
--- | ---
`inboxDir` | "What local folder should I watch for screenshots? (e.g. /Users/barton/proof-log/inbox)"
`doneDir` | "Where should I move processed files? (e.g. /Users/barton/proof-log/done)"
`driveFolderId` | "Share the ID of the Drive folder — it's the last segment of the folder URL"
`sheetId` | "Share the ID of the proof log Sheet — it's the segment after /d/ in the Sheet URL"

`GOOGLE_SERVICE_ACCOUNT_JSON` is already in Doppler — no config entry needed for credentials.

Once the config file is present and complete, proceed to Step 1.

### Step 1 — Get the image to disk

**All script commands in this skill must be run from the skill base directory (`<skill-dir>` shown at skill load time):**

```bash
cd <skill-dir>
```

**Discovery order — check each in sequence and stop at the first match:**

1. **Inbox folder (check first, always):** List the most recent file in the configured inbox — do this automatically without asking:
   ```bash
   ls -t "$(jq -r .inboxDir ~/.config/skool-automations/proof-log.json)" | head -5
   ```
   Use the most recent file as `<input.png>`. Confirm the filename with the user before proceeding.

2. **User attached a file:** the path is already visible in the conversation — use it directly as `<input.png>`.

3. **User pasted inline:** run the extractor — it finds the most-recently-modified JSONL in `~/.claude/projects/` and extracts the last image block:
   ```bash
   python3 scripts/extract_latest_screenshot.py outputs/
   ```
   The last printed path is the image. Use it as `<input.png>` throughout.

4. **Nothing found:** Only if all three checks above come up empty, ask the user to share or attach the screenshot.

### Step 2 — Build the spec from pixels

This is the **only step that produces coordinates**. Do not write any coordinates by hand, and do not estimate them from vision.

```bash
python3 scripts/build_spec.py \
  <input.png> \
  <outputs>/spec.json
```

The script prints every avatar, name bbox, and @mention it found. Review the output to confirm the counts look right (e.g. 4 avatars for a post with 3 comments). If a count is wrong, see Troubleshooting below.

### Step 3 — Add labels (vision pass)

Open `<outputs>/spec.json`. Read the image and replace every `"Person N — add label"` and `"@mention N under Person N — add label"` string with the actual person name. **Do not touch any coordinates.**

Example — before:
```json
{ "type": "header", "label": "Person 1 — add label", "avatar": [...], "name_bbox": [...] }
```
After:
```json
{ "type": "header", "label": "Nicole Chetaud (post author)", "avatar": [...], "name_bbox": [...] }
```

### Step 4 — Build both SVG and PNG outputs

**Step 4a — Build SVG (editable redactions):**

```bash
python3 scripts/build_svg.py \
  <input.png> \
  <outputs>/spec.json \
  <outputs>/skool-redacted.svg
```

**Step 4b — Render PNG (from spec):**

```bash
python3 scripts/render_redactions.py \
  <input.png> \
  <outputs>/skool-redacted.png \
  <outputs>/spec.json
```

Both outputs are always generated — SVG for human editing, PNG for verification and final presentation.

### Step 5 — Verify and iterate (bounded retry loop)

```bash
python3 scripts/verify_redactions.py \
  <input.png> \
  <outputs>/skool-redacted.png \
  <outputs>/spec.json
```

The script checks:
- **Coverage** — centre of every avatar, name block, and mention is teal.
- **No overcoverage** — pixel 30 px below each name block is NOT teal.

**Iteration:** If any check reports `FAIL`:
1. Edit `spec.json` to fix the issue (see Common Fixes below).
2. Re-render PNG (Step 4b) and re-verify.
3. **Max 3 validation failures** — if verification still fails after 3 attempts, proceed to Step 6 with the best passing images and output a warning listing which checks failed.

Track the failure count. If you reach 3 failures, do not continue iterating — move to Step 6.

### Step 6 — Visual check and present

**If verification passed:** Read the PNG output image into context and confirm:
- Every avatar is fully covered.
- Every author name is covered; timestamp visible to its right.
- Every @mention is covered, including the `@` symbol.
- Post title, body text, and UI chrome are all intact.

Then call `SendUserFile` with both `skool-redacted.png` and `skool-redacted.svg`.

**If verification failed after 3 attempts:** Output the best passing images (PNG and SVG) with a **⚠️ VALIDATION WARNING** listing:
- Which specific checks failed (e.g. "overcoverage FAIL on Daljit's body probe")
- What the user can edit manually (open SVG in Affinity Designer to adjust the specific failed regions)

Always include fully qualified paths in your message (e.g. `<skill-dir>/outputs/skool-redacted.png`).

---

## Step 7 — Proof Log Upload (optional)

After producing a verified redacted PNG, upload it to Google Drive and log the entry to the proof-log Sheet.

### 7a — Config

Config is already confirmed in Step 0. Proceed directly to 7b.

### 7b — Upload to Drive

```bash
cd /Users/barton/workspaces/skool-automations
DRIVE_URL=$(pnpm proof-log:upload -- <outputs>/skool-redacted.png)
echo "Drive URL: $DRIVE_URL"
```

The script prints the Drive `webViewLink` to stdout. Capture it for step 7c.

### 7c — Log to Sheet

```bash
pnpm proof-log:update-sheet -- <outputs>/skool-redacted.png "$DRIVE_URL"
```

Appends one row to the Sheet: `[ISO date, filename, drive-url, notes]`. Notes are optional — pass a fourth quoted argument if the user provided context (e.g. `"Q2 cohort proof"`).

### 7d — Move source to done

```bash
mv <source-screenshot> <doneDir>/
```

Replace `<source-screenshot>` with the original input file path and `<doneDir>` with the value from config.

---

## SVG editing (optional refinement)

The SVG output can be edited in Affinity Designer:

Each redaction is a named `<rect>`. Open the SVG — every rect appears as a named layer. Drag to resize, click + Delete to remove, or draw a new rect + set fill `#1F3E3E` + corner radius 12 to add one. Save when done.

To flatten edited SVG back to PNG:

```bash
python3 scripts/flatten_svg.py \
  <outputs>/skool-redacted.svg \
  <outputs>/skool-redacted.png
```

Requires `cairosvg` (`pip3 install cairosvg --break-system-packages`). After flattening, re-run `verify_redactions.py` (Step 5) before presenting.

---

## Common Fixes

**When verification fails, only edit `spec.json`.** Do not modify any `.py` script files.

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Wrong avatar count | Indented replies have different x-column | Check build_spec.py output; both top-level (x≈47) and indented (x≈95) columns are scanned |
| Avatar not fully covered | r slightly too small | Edit spec.json: increase `r` by 3–5 px and re-render |
| Name block exposes a few pixels | `name_bbox x1` slightly narrow | Edit spec.json: increase `x1` by 5–8 px |
| Name block covers timestamp | `name_bbox x1` too wide | Edit spec.json: reduce `x1` until timestamp row is clear |
| @mention not found | Unusual Skool link colour or screenshot zoom | Edit spec.json: add a `"type": "custom"` region with the exact mention bbox |
| Extra false-positive @mention | "See more" or other blue chrome detected | Edit spec.json: delete that region |
| Overcoverage FAIL on body probe | Mention bbox padded bottom lands on probe row | Edit spec.json: reduce that mention's `y1` by 5 px |

---

## Troubleshooting build_spec.py

**Too many avatars (false positives from UI chrome):**
- The grey comment card backgrounds can trigger the detector. The script filters clusters shorter than `MIN_AVATAR_SPAN = 24` px — real avatars span ~42 px. If false positives persist, raise `MIN_AVATAR_SPAN` to 30 and rerun.

**Fewer avatars than expected:**
- Scroll the screenshot: are some comments cut off?
- Very light profile photos can read as white. Temporarily lower `BG_THRESH` to 200 in `build_spec.py` and rerun.

**Name not found for an avatar:**
- The script prints a warning and uses a fallback bbox.
- After rendering, visually check whether the fallback covers the name.
- If not, manually set `name_bbox` in the spec.

**@mention not found:**
- The mention may use an unexpected link colour (e.g. dark mode).
- Add a `"type": "custom"` region covering the visible mention text.

---

## Files

- `scripts/build_spec.py` — **primary** — pixel-scans for avatars, names, and @mentions and writes a complete spec. No estimation.
- `scripts/extract_latest_screenshot.py` — pulls inline-pasted screenshots from the session transcript.
- `scripts/render_redactions.py` — draws teal blocks from a JSON spec (fast path).
- `scripts/verify_redactions.py` — checks coverage and overcoverage.
- `scripts/build_svg.py` — generates a layered SVG for human editing in Affinity Designer.
- `scripts/pixel_calibrate.py` — deprecated — was used to refine vision-estimated coordinates. No longer needed; kept for reference.

---

## Future enhancement — Skool comments API

For posts with logged-in session cookies available, the undocumented endpoint `GET https://api2.skool.com/posts/{post_id}/comments?group-id={group_id}` returns structured JSON including `[@First Last](obj://user/<uuid>)` mention markup. When auth is wired up, prefer fetching post data and rendering a freshly-styled mock with names already absent, rather than redacting a screenshot.
