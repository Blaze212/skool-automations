# Pipeline Tracker — Result Feedback (Badge + Popup History)

**Status:** Draft
**Owner:** Barton Holdridge
**Last updated:** 2026-05-22
**Related:** `006-pipeline-tracker.md`

## Objective

Make webhook failures and partial successes visible to the user without injecting any UI into the
LinkedIn page. After every captured event, the extension surfaces the result via:

1. A colored count badge on the extension's toolbar icon.
2. A "Recent activity" history list in the existing popup, so the user can read what happened.

The host page (LinkedIn) sees nothing — no toasts, no shadow DOM, no DOM mutations — so this is
fully invisible to any host-side detection.

---

## Non-goals

- No in-page toast, bubble, or shadow-DOM widget. Toolbar badge only.
- No retry UI. A failure stays a failure; the user re-fires the LinkedIn action if they want
  another attempt.
- No OS-level (`chrome.notifications`) push. Badge is passive on purpose.
- No backend changes in **Phase 1**. Phase 1 ships only against the response shape the webhook
  emits **today** (`{ success: true }` or a typed error body).

---

## Existing webhook — what it returns today

The backend already exists at
`/Users/barton/workspaces/careersystems/workspace/supabase/functions/pipeline-tracker-webhook/pipeline-tracker-webhook.ts`
and is **not changed in Phase 1**.

Current responses (verbatim from the function):

| Outcome                                | HTTP | Body                                                             |
| -------------------------------------- | ---- | ---------------------------------------------------------------- |
| Row inserted or updated cleanly        | 200  | `{ "success": true }`                                            |
| Row inserted/updated **with warnings** | 200  | `{ "success": true }` ← warnings are logged, **not returned**    |
| Validation error (missing field, etc.) | 400  | `{ "success": false, "error": "…", "code": "VALIDATION_ERROR" }` |
| Unknown api_key                        | 403  | `{ "success": false, "error": "…", "code": "ACCESS_DENIED" }`    |
| Sheet structurally broken / DB error   | 500  | `{ "success": false, "error": "…", "code": "INTERNAL_ERROR" }`   |

Internally the function already collects:

- `UpsertResult.action` — `'inserted' | 'updated'`
- `UpsertResult.usedNameFallback` — boolean (matched on name because URL missing/no match)
- `UpsertResult.warnings: string[]` — e.g. `"payload missing: title"`, `"sheet missing column: Last touch"`

…but none of this currently crosses the wire to the plugin. Phase 2 exposes it.

---

# Phase 1 — Plugin-only changes (no backend work)

Scope: everything happens inside `pipeline-tracker/`. The webhook is treated as a black box that
returns either `200 { success: true }` or a non-2xx error body.

## Result classification (Phase 1)

The plugin can only distinguish two outcomes from the current response shape:

| Server response       | Plugin classifies as | Badge color | Popup row icon |
| --------------------- | -------------------- | ----------- | -------------- |
| `200 { success: true }` | `ok`               | none/clear  | green ✓        |
| Any non-2xx           | `error`              | red `#dc2626` | red ⚠         |
| Network/abort/timeout | `error`              | red `#dc2626` | red ⚠         |

The `partial` (amber) state exists in the schema but is never produced in Phase 1. It lights up
automatically once Phase 2 ships, no plugin code change needed beyond what's listed here.

## Storage shape

New keys added under `chrome.storage.local`:

```ts
// types.ts — extends STORAGE_KEYS
export const STORAGE_KEYS = {
  API_KEY: 'api_key',
  DEBUG_MODE: 'debug_mode',
  LAST_LOGGED_AT: 'last_logged_at',
  LAST_ERROR: 'last_error',
  // new:
  UNREAD_COUNT: 'unread_count',           // number; cleared when popup opens
  HIGHEST_SEVERITY: 'highest_severity',   // 'ok' | 'partial' | 'error'; resets with unread
  HISTORY: 'history',                     // HistoryEntry[]; ring buffer, newest first, cap 10
} as const

export interface HistoryEntry {
  ts: string                                       // ISO timestamp
  status: 'ok' | 'partial' | 'error'
  event_type: 'connection_request' | 'accepted_connection' | 'direct_message'
  name: string                                     // best-effort; may be ''
  page_url: string
  message: string                                  // human-readable summary, see below
  warnings: string[]                               // empty in Phase 1
  code?: string                                    // error code on failure, e.g. 'VALIDATION_ERROR'
  http_status?: number                             // on failure
}
```

## Message strings (Phase 1)

The `message` field is a short human-readable line shown under the row in the popup.

| status  | example message                                       |
| ------- | ----------------------------------------------------- |
| `ok`    | `"Logged"`                                            |
| `error` | `"Connection failed. Check your key."` (403)          |
| `error` | `"Missing required field: name"` (400, from `error` body) |
| `error` | `"Connection timed out"` (AbortError)                 |
| `error` | `"Connection failed"` (network/throw)                 |

Use the existing strings already produced in `background.ts:51-77` — this spec does not invent new
copy.

## Badge logic

`background.ts` calls these after each event:

```ts
chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' })
chrome.action.setBadgeBackgroundColor({ color: severity === 'error' ? '#dc2626' : '#d97706' })
chrome.action.setBadgeTextColor({ color: '#ffffff' })   // ensure legibility on red/amber
```

Severity escalation: if any unread entry is `error`, badge is red. Else if any is `partial`, amber.
Else clear. (Phase 1 only ever produces `ok` or `error`, so badge is either red-with-count or
empty.)

Successful events do **not** increment the unread count. Only `partial` and `error` do. Rationale:
the badge is for things that need attention; a clean ✓ shouldn't nag.

## Popup behavior

Opening the popup:

1. Resets `UNREAD_COUNT` to 0 and clears the badge via `chrome.action.setBadgeText({ text: '' })`.
2. Renders the existing setup/configured UI **plus** a new "Recent activity" section, visible only
   when `HISTORY` has at least one entry.

History rendering (newest first):

```
─── Recent activity ─────────────────────────
⚠ 2:03 PM  Jane Doe — connection request
  Connection failed. Check your key.

✓ 2:00 PM  John Smith — direct message
  Logged

[ Clear history ]
─────────────────────────────────────────────
```

- Icon: red ⚠ for `error`, amber ⚠ for `partial`, green ✓ for `ok`.
- Header line: `{HH:MM AM/PM}  {name or "(unknown)"} — {event_type, prettified}`.
- Sub line: `message` (italicized, slightly dimmed).
- Click row → expands a `<details>` with the full `HistoryEntry` JSON for debugging.
- "Clear history" wipes `HISTORY` and re-hides the section.
- The existing `last_error` / `last_logged_at` row stays in place (do not remove).

## Code touchpoints (Phase 1)

| File                                                | Change                                                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `pipeline-tracker/src/types.ts`                     | Extend `STORAGE_KEYS`; add `HistoryEntry`, `Severity` types                                            |
| `pipeline-tracker/src/background.ts`                | After fetch resolves: classify outcome → push `HistoryEntry` → trim to 10 → update badge + unread count |
| `pipeline-tracker/src/popup/popup.html`             | New `<section id="history">` (hidden by default); "Clear history" button                                |
| `pipeline-tracker/src/popup/popup.ts`               | On open: clear unread + badge, render history list, wire Clear button                                  |
| `tests/unit/pipeline-tracker/background.test.ts` (new) | History ring-buffer trim, badge color escalation, unread count math                                    |
| `tests/unit/pipeline-tracker/popup.test.ts` (new)   | Render entries, formatting, clear button wipes storage                                                 |

No changes to `content.ts`, the four `*-card.ts` files, `manifest.json`, or `build.ts`.

## Acceptance criteria (Phase 1)

1. Sending a connection request that the webhook 200s does **not** raise the badge. Popup shows a
   green ✓ row.
2. Sending a connection request while logged out / wrong api_key shows a red `1` badge and a red ⚠
   row in the popup with "Connection failed. Check your key."
3. Two failures in a row show `2`, three show `3`, etc.
4. Opening the popup clears the badge to empty. History rows remain until "Clear history" is
   clicked.
5. After more than 10 events, only the 10 most recent are kept.
6. The host LinkedIn DOM is byte-identical to the version with the extension uninstalled (verify by
   diffing `document.documentElement.outerHTML` before/after a captured event in an instrumented
   build).

---

# Phase 2 — Backend update (later, separate PR)

Phase 2 lives in the **careersystems** repo, not skool-automations. It is a backwards-compatible
extension to the existing response.

## Webhook response shape (Phase 2)

```ts
// Success — row appended/updated cleanly
{ "success": true, "status": "ok", "action": "inserted", "warnings": [] }

// Partial — row written, but warnings exist
{
  "success": true,
  "status": "partial",
  "action": "updated",
  "used_name_fallback": true,
  "warnings": [
    "payload missing: title",
    "sheet missing column: Last touch"
  ]
}

// Hard failure (unchanged)
{ "success": false, "error": "…", "code": "VALIDATION_ERROR" }
```

Status field is derived: `warnings.length === 0 ? "ok" : "partial"`. `action` and
`used_name_fallback` already exist on `UpsertResult` internally — they just need to be returned.

## Backwards compatibility

Phase 1 plugin code reads:

- `res.ok` → ok-vs-error
- `body.error` → error message on failure

Phase 2 adds `status`, `action`, `warnings`, `used_name_fallback`. Older plugin builds ignore
unknown fields, so the backend can ship before the plugin is updated.

## Plugin follow-up (Phase 2)

Once Phase 2 webhook is live, update `background.ts` classification:

```ts
if (res.ok) {
  const body = await res.json()
  if (body.status === 'partial') {
    push({ status: 'partial', message: summarize(body.warnings), warnings: body.warnings, ... })
  } else {
    push({ status: 'ok', message: 'Logged', warnings: [], ... })
  }
}
```

`summarize(warnings)` → `"Logged · missing: title, company"` etc.

This is the **only** code change needed in the plugin for Phase 2. Badge amber color, popup amber
icon, and the schema are all already in place from Phase 1.

## Acceptance criteria (Phase 2)

1. A connection request for a profile with no Title shows an amber `1` badge and "Logged · missing:
   title" in the popup.
2. A request that matched by name (URL fallback) records `used_name_fallback: true` in the history
   entry and surfaces it in the expanded `<details>` view.
3. A clean event still returns `{ success: true, status: "ok", warnings: [] }` and produces no
   badge.
4. Existing Phase 1 plugin builds continue to work against the new backend (no regressions for the
   ok/error path).

---

## Open questions

- Should the badge persist across browser restarts? (Default: yes — `chrome.storage.local` survives,
  but the badge text is not auto-restored. Service worker should re-apply badge on startup from
  stored `UNREAD_COUNT` / `HIGHEST_SEVERITY`.)
- Should "Clear history" also clear `last_error` / `last_logged_at`? (Default: no — those are
  separate signals from the original spec.)
- Cap of 10 history entries — enough? (Easy to change; revisit after dogfooding.)
