# Proof Log Automation

**Status:** Not started
**Owner:** Barton
**Last updated:** 2026-05-19

## Objective

Automate proof log collection, analysis, redaction, Drive upload, and sheet logging so that the
only manual step is taking screenshots. Barton drops screenshots into an inbox folder, kicks off
a Claude Code routine, and receives a markdown summary. Katie is removed from the workflow entirely.

Target weekly effort: ~15 minutes (screenshots + kick-off + summary review).

## Non-goals

- Automating screenshot capture (manual step intentionally retained)
- Building a UI for browsing proof logs
- Processing non-Skool screenshots
- Any Supabase or edge function involvement — this is entirely Google Sheets + Drive

## Business Rationale

Katie currently spends ~80 min/week collecting, labeling, and uploading proof logs from the Skool
community. The analysis prompt and sheet schema are already defined and stable. Automating this
frees Katie's time, makes the proof log consistent, and gives Barton full ownership of the process
with a reproducible weekly workflow.

## Architecture

### External systems

| System | Role | Auth |
|---|---|---|
| Google Drive | Stores original and redacted screenshot files | Service account key via `GOOGLE_SERVICE_ACCOUNT_JSON` |
| Google Sheets | Proof log spreadsheet; one row per screenshot | Service account key via `GOOGLE_SERVICE_ACCOUNT_JSON` |
| Claude Code | Runs the routine and sub-agents; built-in vision for image analysis | Subscription (no SDK cost) |
| Doppler | Secret management | Doppler project config |

### No Anthropic SDK calls

Image analysis runs inside a Claude Code routine using Claude's native vision — the Read tool
handles images directly. This uses the existing Claude subscription and avoids per-token API costs.

### Repository layout

```
automations/
  proof-log/
    drive-uploader.ts      # CLI: upload one file to Drive, print webViewLink
    proof-log-sheet.ts     # ProofLogSheet class (insertRowAtTop, Sheets API wrapper)
    sheets-updater.ts      # CLI: insert one structured row at top of proof log sheet
```

The routine logic lives in a Claude Code skill (not a TypeScript file) — see Routine section below.

### Routine flow

The Claude Code routine orchestrates the full pipeline with sub-agents for context isolation:

```
1. List all image files in $PROOF_LOG_INBOX_DIR

2. Fan out — spawn one sub-agent per image IN PARALLEL
   Each sub-agent:
     a. Invoke redact-skool-screenshots skill on the image
        → produces <name>-redacted.png (final) and <name>-redacted.svg (editable)
     b. Read and analyze original image → return structured JSON (schema below)

3. For each result (sequentially):
     a. tsx automations/proof-log/drive-uploader.ts <original>      originals → original Drive link
     b. tsx automations/proof-log/drive-uploader.ts <redacted.png>  redacted  → redacted final Drive link
     c. tsx automations/proof-log/drive-uploader.ts <redacted.svg>  svg       → redacted SVG Drive link
     d. tsx automations/proof-log/sheets-updater.ts '<json>'                  → insert row at top of sheet

4. Move processed originals to $PROOF_LOG_DONE_DIR
   Move processed redacted PNG + SVG files to $PROOF_LOG_DONE_DIR/redacted/

5. Emit markdown summary (see Summary section)
```

**Why sub-agents:** Each image read adds vision tokens to the context window. With 10–20 images
per run, sequential processing in one session risks context saturation and degraded analysis
quality. Sub-agents give each image a clean context window. Parallel execution also makes the
run significantly faster.

### Image analysis output schema

Each sub-agent returns a single JSON object:

```json
{
  "title": "string — short descriptive title of the win",
  "date": "YYYY-MM-DD — date visible in the post, or empty string if not visible",
  "area": "one of: Target | Resume | Outreach | Interview | Negotiation | Offer | Mindset",
  "level": "one of: IC | Leader | Executive | Fractional",
  "function": "one of: CS | Data | Finance | HR | IT | Marketing | Product | Program | Sales | Strat & Ops | UX",
  "status": "one of: Laid off | Employed | Fractional",
  "trigger": "1–2 sentences — what prompted them to act or share",
  "behavior": "bulleted list as a single string — concrete actions they took",
  "outcome": "bulleted list as a single string — results and realizations",
  "friction": "what was emotionally hard or surprising",
  "artifacts": "templates, SOPs, or reusable assets worth capturing",
  "main_objection": "direct quote or paraphrase of skepticism the person expressed before their win (e.g. 'I thought cold outreach wouldn't work'); empty string if they didn't state one"
}
```

All label fields (`area`, `level`, `function`, `status`) are constrained to the exact enums above.
If a value cannot be confidently inferred, use the closest match and note uncertainty in the
relevant description field.

### Sheet structure

**Proof Log sheet** — rows inserted at row 2 (newest entry always at top):

| # | Column | Source |
|---|---|---|
| A | Date | From analysis JSON (date of post) |
| B | Screenshot | `=HYPERLINK("original_drive_link","filename.png")` formula |
| C | Redacted | `=HYPERLINK("redacted_png_drive_link","filename-redacted.png")` formula |
| D | Redacted (SVG) | `=HYPERLINK("redacted_svg_drive_link","filename-redacted.svg")` formula |
| E | Area | From analysis JSON |
| F | Level | From analysis JSON |
| G | Function | From analysis JSON |
| H | Status | From analysis JSON |
| I | Trigger | From analysis JSON |
| J | Behavior | From analysis JSON |
| K | Outcome | From analysis JSON |
| L | Friction/Surprise | From analysis JSON |
| M | Artifacts | From analysis JSON |
| N | Main Objection | From analysis JSON |

Row 2 insertion (not append) preserves newest-first ordering. `ProofLogSheet.insertRowAtTop()`
uses `spreadsheets.batchUpdate` with `insertDimension` to shift existing rows down before writing.

All three image columns (B, C, D) are `=HYPERLINK(...)` formulas — filename is clickable and
opens the Drive file directly. Column C links the flat PNG for sharing; column D links the SVG
for editing in Affinity Designer.

### Drive folder structure

```
proof-log/
  originals/
    YYYY-WW/          # ISO week folder, e.g. 2026-21
      <filename>.png
  redacted/
    YYYY-WW/
      <filename>-redacted.png
  svg/
    YYYY-WW/
      <filename>-redacted.svg
```

`drive-uploader.ts` accepts the target subfolder (`originals`, `redacted`, or `svg`) as a CLI
argument and auto-creates the week folder if it does not exist.

### Summary output

After all images are processed, the routine emits a markdown summary to stdout:

```
## Proof Log Run — YYYY-MM-DD
Processed: N screenshots

By Area:     Offer (4), Outreach (3), Mindset (1)
By Level:    IC (6), Leader (2)
By Function: Program (3), HR (2), Strat & Ops (2), Sales (1)
By Status:   Laid off (5), Employed (2), Fractional (1)

Entries:
- [IC PM frustrated with lack of direction] — Outreach / IC / Program / Laid off
- ...

Sheet: <link>
```

### Secrets & environment

| Secret / Env var | Used by |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | `drive-uploader.ts`, `sheets-updater.ts` |
| `PROOF_LOG_SHEET_ID` | `sheets-updater.ts` |
| `PROOF_LOG_DRIVE_FOLDER_ID` | `drive-uploader.ts` (root folder for originals + redacted) |
| `PROOF_LOG_INBOX_DIR` | Routine — local path where screenshots are dropped |
| `PROOF_LOG_DONE_DIR` | Routine — archive path after processing |

All secrets stored in Doppler. Scripts invoked by the routine via `doppler run -- tsx ...`.

### Running the routine

```bash
# Drop screenshots into $PROOF_LOG_INBOX_DIR, then:
/proof-log   # Claude Code skill — runs full pipeline and emits summary
```

Schedule is deferred until after manual testing is validated.

## Implementation Phases

### Phase 1 — Manual Run & Schema Calibration

No dev. Barton runs proof logs manually for one week using the analysis prompt to produce
hand-labeled examples. Output:
- Confirmed proof log sheet ID and Drive folder ID
- 3–5 labeled examples per label type covering edge cases (ambiguous area, mixed level, etc.)
- Full list of Drive folder paths confirmed
- Main Objection field semantics confirmed (objection the win counters, e.g. "warm outreach doesn't work")

These examples feed directly into the sub-agent prompt as few-shot anchors.

### Phase 2 — CLI Helper Scripts

**Files:**
- `automations/proof-log/proof-log-sheet.ts`
- `automations/proof-log/drive-uploader.ts`
- `automations/proof-log/sheets-updater.ts`

`ProofLogSheet` extends `SheetsClient` with:
- `insertRowAtTop(row: ProofLogRow)` — `insertDimension` batchUpdate to shift rows, then writes
  columns A–L at row 2
- `ProofLogRow` interface matching the 12-column schema above

`drive-uploader.ts` CLI:
```
tsx automations/proof-log/drive-uploader.ts <file-path> <originals|redacted>
# prints: <webViewLink>
```

`sheets-updater.ts` CLI:
```
tsx automations/proof-log/sheets-updater.ts '<json-string>'
# parses JSON, calls ProofLogSheet.insertRowAtTop(), exits 0 on success
```

### Phase 3 — Routine Prompt & Skill

Author the Claude Code skill file (`/proof-log`) with:
- Full pipeline instructions (steps 1–5 from the Routine section above)
- Sub-agent prompt template including the JSON schema and all label enumerations
- Few-shot examples from Phase 1 embedded in the sub-agent prompt
- Summary format template

Test against 2–3 real screenshots end-to-end before proceeding to Phase 4.

### Phase 4 — End-to-End Testing & Debugging

Run the full pipeline against a batch of 10–15 real screenshots:
- Validate label accuracy across all four dimensions
- Confirm Drive folder structure and file naming
- Confirm sheet rows insert at top in correct order
- Confirm Screenshot cell hyperlink opens the Drive file
- Confirm summary counts match processed files
- Confirm processed files are moved to done dir

Iterate on the sub-agent prompt if label accuracy is poor on any dimension.

### Phase 5 — Schedule (deferred)

After Phase 4 is validated:
- Use `/schedule` skill to create a weekly routine
- Or keep as manual `pnpm proof-log` kick-off (lower complexity)

## Edge Cases & Risk

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Date not visible in screenshot | M | L | Sub-agent returns empty string; `sheets-updater` writes empty cell; Barton fills manually |
| Label cannot be confidently inferred | M | L | Sub-agent uses closest match and notes uncertainty in description field |
| Sub-agent returns malformed JSON | L | M | `sheets-updater.ts` validates JSON shape before writing; logs error and skips row |
| Drive folder creation race condition (parallel uploads) | L | L | `drive-uploader.ts` checks for existing week folder before creating |
| Sheet row 2 insert collides with header row | L | H | `insertRowAtTop` always targets index 1 (0-based), which is row 2 — header at row 1 is never shifted |
| Redaction skill fails on a specific image | L | M | Sub-agent logs failure; routine continues with remaining images; failed image stays in inbox |
| 10+ images saturate sub-agent context | L | L | Mitigated by design — each sub-agent handles exactly one image |

## Acceptance Criteria

### Phase 1
- [ ] Proof log sheet ID and Drive folder IDs confirmed and added to Doppler
- [ ] 3–5 hand-labeled example entries exist in the sheet as reference

### Phase 2
- [ ] `tsx automations/proof-log/drive-uploader.ts <file> originals` uploads and prints Drive link
- [ ] `tsx automations/proof-log/drive-uploader.ts <file> redacted` uploads to redacted subfolder
- [ ] `tsx automations/proof-log/drive-uploader.ts <file> svg` uploads to svg subfolder
- [ ] Week subfolder (e.g. `2026-21`) is auto-created if it does not exist
- [ ] `tsx automations/proof-log/sheets-updater.ts '<json>'` inserts at row 2 with all 14 columns; existing rows shift down
- [ ] Running `sheets-updater.ts` twice inserts two rows (idempotent is not required — each run is a new entry)
- [ ] Columns B, C, D contain `=HYPERLINK(...)` formulas (not plain text links)
- [ ] `pnpm typecheck` passes

### Phase 3
- [ ] `/proof-log` skill processes 2–3 test screenshots end-to-end without error
- [ ] Each screenshot produces one Drive upload (original), one Drive upload (redacted), and one sheet row
- [ ] Summary output counts match number of processed files

### Phase 4
- [ ] 10–15 screenshot batch completes without context errors or mid-run failures
- [ ] Label accuracy spot-checked: area, level, function, status correct on ≥ 90% of entries
- [ ] Sheet rows are in newest-first order after batch run
- [ ] All processed files moved to done dir; inbox is empty after run
- [ ] Redacted image Drive link accessible from Screenshot cell note
