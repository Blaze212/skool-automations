# On-device extraction eval

A standalone harness that scores the pipeline-tracker's **production extraction prompt** against
Chrome's **on-device model (Gemini Nano)** — the exact `LanguageModel` surface the real sidepanel
uses. It lives inside this throwaway `drag-link-inspector` extension so it never has to be ripped out
of the real plugin. No build step.

## What it does

For each fixture (a real `trimmedHtml` fragment the sidepanel would feed the model), it runs the
verbatim production prompt through the local model, parses the JSON, and scores the five fields
against hand-authored truth labels.

**Hybrid scoring**

- `name`, `linkedin_url`, `suggested_event_type` → deterministic normalized match
  (URL ignores tracking params / trailing slash; stage is exact).
- `title`, `message_text` → fuzzy: normalized equality, substring containment, or token-Jaccard
  over a threshold. A per-field similarity % is shown.

## How to run

1. In Chrome (a build with the on-device Prompt API available), go to `chrome://extensions`,
   enable **Developer mode**, **Load unpacked**, and select the `drag-link-inspector 3` folder.
2. Click the extension's toolbar button to open the side panel, then click
   **▶ Open on-device extraction eval** (or navigate to `chrome-extension://<id>/eval.html`).
3. The banner reports model availability. If it says `downloadable`, click **Download model** once.
4. Click **Run eval (all)**. Cases run sequentially (one fresh session each, like prod). Watch the
   summary, per-category breakdown, and per-case expected-vs-model diffs fill in.
5. **Download results JSON** for an offline record; **Re-run failed only** after a prompt tweak.

## Refining the prompt

`extract-contact.js` holds `buildPrompt()` — the iteration surface. Edit the prompt there, reload
the extension, and re-run — the scores tell you whether a change helped. When you settle on a better
prompt, port the same edit back into the production `packages/scraping-core/.../extract-contact.ts`.

**This prompt is currently AHEAD of production** with three changes pending a port-back:

1. **`ownerName` identity block + "most recent message WE sent" rule** for `message_text`. Each
   fixture carries `ownerName` (here `Barton Holdridge`), threaded into the prompt so the model can
   tell our messages from the other person's in a thread and return only the latest one we sent.
2. **stage hints** — `Pending` = an invite we sent (`connection_request`); a greeting like "Looking
   forward to connecting with you here" = `accepted_connection`, not a request.
3. **verbatim title** — copy the entire `|`-delimited headline, don't summarize it.

> Production port also needs the plugin to **collect the user's name** (settings / first-run) and
> pass it as `ExtractContactInput.ownerName`. Until then production runs with no owner name (the
> prompt falls back to a generic "the account owner" phrasing).

> Note: the eval scores the model's **raw** extraction (no reconciliation against the heuristic
> candidate — the captures don't carry one). `null` is preserved so "model said null" matches a
> `null` truth label.

## Files

| File | Role |
| --- | --- |
| `eval.html` | Eval page UI (open as an extension page) |
| `eval.js` | Runner + report rendering |
| `scoring.js` | Pure hybrid scoring logic (DOM-free) |
| `extract-contact.js` | Standalone port of the production extractor + prompt |
| `eval-dataset.js` | Auto-generated truth dataset (44 cases, 8 categories) |
| `scoring.test.mjs` | `node "scoring.test.mjs"` — sanity tests for the scorer |

## Regenerating the dataset

Inputs are extracted byte-exact from `LinkedInRawCapturesForPromptTesting.html` (the
`DROP — LLM-bound content` fragments). Truth labels are hand-authored in the generator.
To change labels or re-extract:

```bash
node scripts/gen-eval-dataset.mjs   # run from repo root; rewrites eval-dataset.js
```

### Truth-labeling conventions used

- The **primary contact** is the profile the fragment centers on; `is a mutual connection` /
  "people also viewed" names are decoys and must be ignored even when bold/linked.
- In a message thread the contact is the **other** party, never Barton (the account owner), and his
  profile URL must not be picked.
- `message_text` in a thread = the **most recent message the owner (Barton) sent**, as plain text —
  not the first message, not the other person's reply. If the owner's latest message has no body in
  the captured fragment (e.g. Vince Toves — only a timestamp header), the label is `null`.
- Stage: `Pending` invite = `connection_request`; a plain `Connect`/`Follow`/`Message` button with
  no action taken = `null`; the "Looking forward to connecting with you here, X!" greeting =
  `accepted_connection`; a substantive outreach pitch = `direct_message`.
