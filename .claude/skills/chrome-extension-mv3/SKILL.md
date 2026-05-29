---
name: chrome-extension-mv3
description: >
  Best-practice reference for Chrome extension MV3 development in this repo
  (pipeline-tracker, linkedin-tracker). Use this skill whenever implementing
  or reviewing extension code that touches: service worker lifecycle,
  chrome.storage.local, chrome.sidePanel, externally_connectable, long-lived
  ports (chrome.runtime.connect), the Chrome built-in AI Prompt API
  (LanguageModel), Chrome Web Store policy / privacy disclosure, or pnpm
  workspace + TypeScript project references setup. Covers verified API
  signatures, lifecycle gotchas (port-open does NOT extend SW from Chrome
  116+), MessageSender validation patterns, storage quota limits, and
  Limited Use policy compliance. Referenced by specs 011, 012, 013.
---

# Chrome Extension MV3 — best practices

This skill is a structured reference, not a workflow. Open the relevant file
under `references/` when implementing or reviewing code in the listed area.

These references back specs:

- **[011 — Scraping Core Extraction](../../../docs/specs/011-pipeline-tracker-scraping-core.md)**
- **[012 — Publishable Build](../../../docs/specs/012-pipeline-tracker-publishable.md)**
- **[013 — On-Device AI Fallback](../../../docs/specs/013-pipeline-tracker-ai-fallback.md)**

## When to read each reference

| Topic | File | Open when… |
|---|---|---|
| MV3 service worker lifecycle (30 s idle, port-open doesn't extend SW, init pattern) | [`references/chrome_mv3_sw_lifecycle.md`](references/chrome_mv3_sw_lifecycle.md) | Designing any handler that runs async work; using `chrome.runtime.connect`; debugging "SW died mid-flow" bugs. |
| Chrome built-in AI Prompt API (`LanguageModel` — availability, create, prompt, monitor, AbortSignal, responseConstraint) | [`references/chrome_prompt_api.md`](references/chrome_prompt_api.md) | Implementing or reviewing any `LanguageModel.*` call. Chrome 138+ stable for extensions; no special manifest permission today. |
| `chrome.sidePanel` API (`setPanelBehavior` is CODE, not manifest; per-tab vs global) | [`references/chrome_side_panel.md`](references/chrome_side_panel.md) | Adding a side panel; debugging "toolbar icon does nothing"; per-tab UI variation. |
| `externally_connectable` + `MessageSender` validation + TLS channel ID | [`references/chrome_externally_connectable.md`](references/chrome_externally_connectable.md) | Adding/changing `externally_connectable.matches`; writing `onMessageExternal` / `onConnectExternal` handlers; reviewing ext↔web app handshakes. |
| `chrome.storage.local` (10 MB quota, atomicity, `unlimitedStorage`, hot/cold split, init guard) | [`references/chrome_storage.md`](references/chrome_storage.md) | Designing extension state; sizing decisions; debugging quota-exceeded errors; implementing read-modify-write. |
| Chrome Web Store program policy (privacy policy triggers, Limited Use, data categories, AI disclosure) | [`references/chrome_web_store_policy.md`](references/chrome_web_store_policy.md) | Before any submission; when adding new permissions; when AI features touch user data. |
| pnpm workspaces + TypeScript project references (`workspace:*` protocol, `composite: true`, `tsc --build`) | [`references/pnpm_typescript_monorepo.md`](references/pnpm_typescript_monorepo.md) | Adding a workspace package; debugging cross-package imports; setting up incremental TS builds. |

## Common gotchas (TL;DR — read the file before relying on these)

- **MV3 port lifecycle**: opening a long-lived port does NOT keep the SW alive (Chrome 116+).
  Sending messages over it does. Persist state machine to `chrome.storage.local` so SW
  respawn picks up where it left off.
- **Side panel**: `chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: true})` MUST
  be called from the SW (typically in `onInstalled`). There is no manifest field for this.
- **externally_connectable defaults**: if you don't declare it, OTHER EXTENSIONS can still
  connect (default-allow); only web pages are default-denied. Always declare explicitly.
- **Prompt API**: stable for extensions in Chrome 138+, no special manifest permission
  today. Wrap every `create()` / `prompt()` / `measureInputUsage()` in an `AbortSignal`
  timeout. Never throw to the caller — return `null` on any error.
- **`responseConstraint`** for JSON output is Chrome 137+. Use a JSON Schema, not
  prompt-engineered "return JSON" instructions.
- **`chrome.storage.local` quota**: 10 MB (5 MB in Chrome 113 and earlier). Hot/cold split
  (keep index small, store payloads under per-id keys) for many small objects.
- **MessageSender validation**: trust `sender.origin`, not `sender.url`. Validate
  `sender.tab?.id` presence. Consider `accepts_tls_channel_id` for stronger sender identity.
- **pnpm workspaces**: `composite: true` is mandatory on every referenced tsconfig;
  cross-package deps use the `workspace:*` protocol; build with `tsc --build`.

## Verification dates

Each reference file has a "verified YYYY-MM-DD" line at the top. If a date is more than ~3
months old when you're using it, re-verify against current Chrome documentation before
relying on specific API signatures.

## Related skills + docs

- `ai-provider-usage` — server-side AI client patterns (separate from on-device Prompt API).
- `new-edge-function` — Supabase edge function scaffold (server side of the binding
  handshake described in spec 012).
- `spec-writer` — spec authoring conventions.
- `plan-eng-review` — design review workflow that produced the spec 012 review.
