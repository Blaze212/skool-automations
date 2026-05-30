# Pipeline Tracker — Publishable Chrome Extension

**Status:** Draft
**Owner:** Barton Holdridge
**Last updated:** 2026-05-29

**Related (must be read first):**

- [006-pipeline-tracker.md](006-pipeline-tracker.md) — current internal extension (People-sheet upsert via `pipeline-tracker-webhook`)
- [007-pipeline-tracker-result-feedback.md](007-pipeline-tracker-result-feedback.md) — badge + popup history; defines `HistoryEntry`, `Severity`, `BADGE_*`
- [008-pipeline-tracker-ai-field-extraction.md](008-pipeline-tracker-ai-field-extraction.md) — server-side `gpt-5-nano` extraction in the webhook (internal build only)
- [009-pipeline-tracker-outbox-queue.md](009-pipeline-tracker-outbox-queue.md) — durable outbox in `chrome.storage.local` (`OutboxEntry`, `OUTBOX_CAP=50`, `OUTBOX_MAX_ATTEMPTS=3`)
- [011-pipeline-tracker-scraping-core.md](011-pipeline-tracker-scraping-core.md) — **prereq**: extracts cards + validator + orchestrator into `@cs/scraping-core`

**Companion follow-ons (can ship before, after, or in parallel — except 014 depends on this):**

- [013-pipeline-tracker-ai-fallback.md](013-pipeline-tracker-ai-fallback.md) — on-device LLM
  field recovery. This spec defines the `recovered_html` wire format and per-id keyed storage
  shape that spec 013 writes into; spec 013 owns the actual model invocation.
- [014-pipeline-tracker-shared-side-panel.md](014-pipeline-tracker-shared-side-panel.md) —
  retires the internal build's popup in favor of the side panel introduced here. Depends on
  this spec's `sidepanel/` + `DestinationStrategy` landing.

## Prerequisites

Spec 011 must be merged before Phase 0 of this spec begins:

- Repo is a pnpm workspace.
- `packages/scraping-core/` exists with cards + `extract` + `validate` + canonical
  `PipelineEvent` type.
- `pipeline-tracker/src/content.ts` already imports from `@cs/scraping-core`.
- CI guard: `*Card` class symbols only live in `packages/scraping-core/`.

This spec **extends** 006/007/008/009 and consumes 011. It does not replace any of them, does
not change the existing webhook contract, and does not disturb the existing People-sheet upsert
flow. Everything in those specs continues to work in the internal extension build.

Spec 013 (AI fallback) is independent: this spec ships and works without it (the `source` field
is always `'selectors'` until 013 lands; the `recovered_html_*` keyed store is defined here but
not populated until 013 wires in the model invocation).

---

## Objective

Evolve the existing `pipeline-tracker/` source (per specs 006–009) so it can build two artifacts from one codebase:

1. **Internal build** — unpacked install, exactly the behavior of today. Captures LinkedIn outreach, drains the outbox to `pipeline-tracker-webhook`, upserts the People sheet. Used by Barton + fractional clients. Zero behavior change vs. today.
2. **Publishable build** — Chrome Web Store target. Same scraping. Same outbox semantics. **No webhook host permission, no API key, no external network calls initiated by the extension.** Captured events sit in the local outbox until the user opens `app.cmcareersystems.com` and clicks "Sync"; that page reads from the extension over `externally_connectable` and POSTs to its own backend.

Extraction logic (selectors, card classification, optional AI fallback) is byte-identical between the two builds — both consume one shared scraping core (invariant **I-1**), provided by spec 011.

## Non-goals

- No change to the existing internal flow (webhook URL, People-sheet schema, `pipeline-tracker-webhook` contract, badge/history rules, outbox semantics).
- No deprecation or retirement of `linkedin-tracker/` in this spec — tracked separately.
- No Firefox / Safari support.
- No paid features in v1.0.
- No extraction-failure telemetry phoned home. Recovery rates are deducible from the `source` field on rows that reach the backend.
- No dedup, reply detection, or dashboards in the extension itself.

---

## Repository layout

`packages/scraping-core/` is delivered by the prereq scraping-core spec and is shown here only for
reference. This spec only modifies `pipeline-tracker/`.

```
skool-automations/
├── packages/
│   └── scraping-core/                ← from prereq spec; not modified here
│
└── pipeline-tracker/                 ← single source, two build targets
    ├── src/
    │   ├── content.ts                ← already imports from @cs/scraping-core (prereq spec)
    │   ├── background.ts             ← thin per-build wiring (DestinationStrategy + outbox drainer)
    │   ├── popup/                    ← INTERNAL build (unchanged)
    │   ├── sidepanel/                ← PUBLISHABLE build (new)
    │   ├── manifest.internal.json
    │   ├── manifest.publishable.json
    │   ├── types.ts                  ← canonical types (PipelineEvent, HistoryEntry, OutboxEntry, …)
    │   ├── storage.ts                ← typed facade over chrome.storage.local
    │   ├── destination.ts            ← DestinationStrategy + Webhook/AppSync impls
    │   └── icons/
    └── build.ts                      ← --target=internal|publishable; selects manifest + UI +
                                        DestinationStrategy
```

`linkedin-tracker/` (current publishable shape under spec 003) is **not** modified by this spec.

What differs between the two builds:

| Concern | Internal | Publishable |
|---|---|---|
| Manifest | `manifest.internal.json` | `manifest.publishable.json` |
| Host permissions | linkedin.com + project supabase.co | linkedin.com only |
| `externally_connectable` | none | `https://app.cmcareersystems.com/*` |
| UI surface | popup (existing) | side panel (new) |
| Destination strategy | `WebhookAutoPushStrategy` → drains outbox to `pipeline-tracker-webhook` | `AppSyncStrategy` → no-op on capture; app pulls via `sync-pull` |
| Outbox drainer trigger | `chrome.alarms` keep-warm + on-capture (existing) | on `sync-pull` only |
| Outbox cap | `OUTBOX_CAP=50`; staleness aging at `OUTBOX_STALE_AFTER_MS` (7d) | **No cap on unsynced storage**; no staleness aging. Side panel paginates at 500. See [D-rev-25](#section-from-publishable-review). |
| Badge between capture and sync | n/a — drain is autonomous | `unsyncedCount` rendered in `BADGE_COLOR_PENDING` (#9333ea); error/partial override per spec 007. See [D-rev-26](#section-from-publishable-review). |

Everything else — scraping, validation, AI fallback decision, storage shape, badge/history rules — is identical.

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────────────┐
│                              LinkedIn tab                                   │
│                                                                             │
│   pipeline-tracker/src/content.ts (identical across builds)                 │
│     ├─ MutationObserver: send-button clicks + accept flows                  │
│     ├─ scraping-core/extract({document, target}):                           │
│     │     1. Router: Card.from(target) → which Card class                   │
│     │     2. selectors → {name, title, linkedin_url, message_text}          │
│     │     3. validate(): missing required? noisy title?                     │
│     │     4. [optional AI fallback — owned by spec 013; off by default]    │
│     │     5. → {event: PipelineEvent, source: 'selectors' | 'ai-recovered'} │
│     ├─ storage.outbox.enqueue(event)         ← spec 009 / D-rev-6           │
│     ├─ storage.history.appendPending(event)  ← spec 007 / D-rev-6           │
│     └─ chrome.runtime.sendMessage(event)     (background drains; failure of │
│                                               this call is non-fatal — the  │
│                                               outbox entry survives)        │
└────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  background.ts (MV3 service worker)                                         │
│                                                                             │
│  onMessage(event):                                                          │
│     • (event is ALREADY in outbox + history-pending — content did it)       │
│     • destination.onEventCaptured(event)                                    │
│         which triggers drain (internal) or no-ops (publishable)             │
│                                                                             │
│  destination strategy (constructed once per SW spin-up):                    │
│     INTERNAL:   WebhookAutoPushStrategy → drain outbox to webhook,          │
│                  classify response, update HistoryEntry in place,           │
│                  retry up to OUTBOX_MAX_ATTEMPTS, age out at                │
│                  OUTBOX_STALE_AFTER_MS.                                     │
│     PUBLISHABLE: AppSyncStrategy.onEventCaptured() = no-op                  │
│                                                                             │
│  onMessageExternal (publishable only) — D-rev-27/28/29:                     │
│     • ping (no token)        → {version, installed: true}                   │
│     • ping (valid token)     → +eventCount, unsyncedCount, bound: true      │
│     • ping (bad token)       → {installed: true, bound: false}              │
│     • sync-pull (valid tok)  → read outbox snapshot; lazily attach          │
│                                  recovered_html_<id> per row; return        │
│                                  {rows, syncedIds}                          │
│     • sync-ack (valid tok)   → for each id in syncedIds, atomically:        │
│                                  storage.outbox.remove(id);                 │
│                                  storage.recoveredHtml.remove(id);          │
│                                  storage.history.resolve(id, {status:'ok'}) │
│     • any with bad token     → {error: 'NOT_BOUND'}                         │
└────────────────────────────────────────────────────────────────────────────┘
                  │                                            │
                  ▼                                            ▼
   ┌──────────────────────────────┐         ┌──────────────────────────────┐
   │ INTERNAL build               │         │ PUBLISHABLE build            │
   │   popup (existing)           │         │   side panel + binding flow  │
   │   badge: ✓ / ! / ✕           │         │   badge: ✓ / ! / ✕ / pending │
   │   history list (HISTORY_CAP) │         │   history list + sync state  │
   │   → pipeline-tracker-webhook │         │   → app.cmcareersystems.com  │
   │   → People sheet upsert      │         │     posts to its own backend │
   │                              │         │     /api/pipeline/import     │
   └──────────────────────────────┘         └──────────────────────────────┘

Storage (both builds, single schema except outbox cap):
  chrome.storage.local:
    api_key, debug_mode, last_logged_at, last_error,
    unread_count, highest_severity, last_status,        ← spec 007
    history: HistoryEntry[],   (cap HISTORY_CAP=10)     ← spec 007
    outbox:  OutboxEntry[],                             ← spec 009
        • internal:    OUTBOX_CAP=50, staleness aging
        • publishable: NO cap, NO aging (D-rev-25)
    last_synced_at: string | null,                      ← NEW (publishable)
    settings: {                                         ← NEW
      ai_fallback_enabled: boolean,
      capture_message_bodies: boolean,                  ← publishable only;
                                                         off by default
      first_run_completed: boolean,
    },
    binding: {                                          ← publishable only
      token: string,                                    ← UUIDv4
      bound_at: string,                                 ← ISO timestamp
      status: 'pending' | 'confirmed',                  ← D-rev-8
    } | null,
    recovered_html_<history_id>: string,                ← NEW (publishable);
                                                         per-id keys, lazily
                                                         attached at sync-pull
                                                         and CSV export.
                                                         D-rev-28.
```

---

## Decisions (rebased)

### D1. Outbox is the source of truth for "what hasn't been delivered yet"

Both builds use the existing spec-009 outbox. `OutboxEntry.history_id` is the cross-build stable identifier.

- Internal: `WebhookAutoPushStrategy.drain()` is the existing `drainOutbox()` in `background.ts` on main, refactored behind the strategy interface. POSTs to `pipeline-tracker-webhook`. Classifies response per spec 007. Updates `HistoryEntry` in place. Retries up to `OUTBOX_MAX_ATTEMPTS`; staleness handled by `OUTBOX_STALE_AFTER_MS`.
- Publishable: outbox grows on capture, drained only by `sync-pull`. There is no automatic background drain. `OUTBOX_STALE_AFTER_MS` still applies — events older than 7 days that were never synced are dropped with a final `HistoryEntry { status: 'error', code: 'STALE_UNSYNCED' }`.

### D2. Sync protocol — explicit ID set (no time watermark)

Decision **1A** from review. The original spec used `watermark = Date.now()` at sync-pull and acked all rows with `capturedAt <= watermark`. That introduced a TOCTOU race: a row enqueued in the window between the outbox read and `Date.now()` would be acked but not delivered → silent data loss. The replacement protocol acks by explicit ID set, which is idempotent and clock-independent.

```ts
// chrome.runtime.sendMessage(EXT_ID, ...) — publishable only, externally_connectable

// Ping (auth-gated counts per D-rev-27)
{ type: 'ping' }                              → { version, installed: true }
{ type: 'ping', bindingToken: string }
  • token matches storage.binding.token AND status==='confirmed'
                                              → { version, installed: true,
                                                  eventCount, unsyncedCount,
                                                  bound: true }
  • token mismatch / no binding               → { installed: true, bound: false }
  • Pre-bind, ping returns only presence — no PII, no counts. App uses this to
    decide between "Connect" CTA and "Sync N events" CTA. See D-rev-27.

// Pull unsynced rows (auth required)
{ type: 'sync-pull', bindingToken: string }
  → { rows: PipelineEvent[], syncedIds: string[] }  (token matches)
  → { error: 'NOT_BOUND' }                          (token mismatch)
  • Reads outbox snapshot
  • Filters entries with no successful prior ack
  • Returns rows in capture order
  • syncedIds = rows.map(r => r.history_id)
  • Recovered HTML is read lazily from per-id keys at this point (D-rev-28) and
    re-attached to each row as `row.recovered_html` for the trip to the backend.
  • No mutation. Idempotent — calling twice returns the same rows.

// Acknowledge a specific set of IDs as delivered (auth required)
{ type: 'sync-ack', bindingToken: string, syncedIds: string[] }
  → { ackedCount: number }                          (token matches)
  → { error: 'NOT_BOUND' }                          (token mismatch)
  • For each id in syncedIds, atomically:
      - storage.outbox.remove(id)
      - storage.recoveredHtml.remove(id)          ← per-id keyed store (D-rev-28)
      - storage.history.resolve(id, {status: 'ok', ts: <now>,
                                     message: 'Synced via app'})
    `markSynced` is shorthand for the three-step removal above — the device
    holds NO synced-event archive locally; the backend is the synced archive
    (D-rev-29).
  • Unknown ids are silently ignored (idempotent re-ack).
```

No `Date.now()` watermark. No coupling to system clock. A row enqueued during the round trip is simply not in `syncedIds` and remains unsynced for the next pull.

### D3. Extension ↔ page binding (Web Store security)

Decision **2A** from review.

The page-side `/api/pipeline/import` is authenticated by session cookie — that protects the *write to the backend*. It does **not** protect the *read from the extension over `externally_connectable`*. Without a separate binding, any code on `app.cmcareersystems.com` (XSS, third-party browser extension with host permissions for that origin, future internal subpath) can call `sync-pull` and exfiltrate the user's full outreach log.

#### Binding handshake (first run)

```
  ┌────────────────┐                                  ┌─────────────────────────┐
  │  Side panel    │                                  │  app.cmcareersystems    │
  │  (extension-   │                                  │  page (logged in)       │
  │   owned UI)    │                                  │                         │
  └────────────────┘                                  └─────────────────────────┘
        │                                                       │
        │ user clicks "Connect to CareerSystems"                │
        │                                                       │
        │ generate bindingToken = crypto.randomUUID()           │
        │ storage.binding = {token, bound_at: ISO}              │
        │                                                       │
        │ chrome.tabs.sendMessage(activeAppTabId, {             │
        │   type: 'bind-offer', bindingToken                    │
        │ })                                                    │
        │ ──────────────────────────────────────────────────────►
        │                                                       │
        │                       POST /api/pipeline/bind-extension│
        │                       body: { bindingToken }          │
        │                       (session-cookie auth)           │
        │                                                       │
        │                       (backend stores token on user)  │
        │                                                       │
        │ ◄──────────────────── { ok: true, userId }            │
        │                                                       │
        │ side panel: render "Connected" state                  │
```

#### Subsequent sync (any visit to app.cmcareersystems.com)

```
  app page → reads bindingToken from /api/pipeline/binding-status (server-side)
           → calls sendMessage(EXT_ID, {type: 'sync-pull', bindingToken})
           → POSTs returned rows to /api/pipeline/import
           → calls sendMessage(EXT_ID, {type: 'sync-ack', bindingToken, syncedIds})
```

Token mismatch on any of `sync-pull` / `sync-ack` → extension responds `{ error: 'NOT_BOUND' }` and refuses. `ping` is safe to answer unbound (no PII; counts only).

**Disconnect** (side panel): clears `storage.binding`. App-side may call `/api/pipeline/unbind-extension` to wipe the server-side copy. Re-binding requires re-running the first-run flow.

**Required CareerSystems-app endpoints (out of scope for this repo, called out for the app team):**

- `POST /api/pipeline/bind-extension` — accept `bindingToken`, store on the authenticated user.
- `GET  /api/pipeline/binding-status` — return current `bindingToken` (or `null`) for the authenticated user.
- `POST /api/pipeline/import` — accept rows; idempotent on `PipelineEvent.history_id`.
- `POST /api/pipeline/unbind-extension` — wipe the stored token.

### D4. AI extraction (delegated to spec 013)

The on-device AI fallback that fills `source: 'ai-recovered'` rows and populates
`recovered_html_<history_id>` per-id keys lives in [spec 013](013-pipeline-tracker-ai-fallback.md).

This spec defines the wire format (`source` field on `PipelineEvent`, `recovered_html` attached
at sync-pull time) and the keyed-storage shape that spec 013 writes into. It does NOT define
the model invocation, prompt, schema, runtime guards, side-channel closure, or settings UI for
the model-download toggle — all that ships in 013.

The `source` field on the canonical `PipelineEvent` (defined in `@cs/scraping-core/types.ts`
per spec 011):

```ts
type ExtractionSource =
  | 'selectors'        // clean scrape, no AI; default until spec 013 ships
  | 'ai-recovered';    // on-device AI filled in at least one required field (spec 013)
```

Until spec 013 ships, every event captured by this build has `source: 'selectors'` and the
`recovered_html_*` keyed store is empty. This spec's sync protocol is forward-compatible: when
013 lands, the same sync-pull / sync-ack handlers carry recovered rows without change.

The internal build also has the server-side `gpt-5-nano` reconciliation from spec 008 (gated on
`debug_mode`), which is unaffected by either this spec or 013.

### D5. Storage schema — extends, doesn't replace

Decision **5A** from review. The schema is the union of spec-007 + spec-009 + new keys. No existing key is removed; no existing semantics is changed.

```ts
// pipeline-tracker/src/types.ts (additions only)

export interface Settings {
  // ai_fallback_enabled + ai_model_downloaded are added by spec 013 when it lands.
  // Storage facade in this spec creates the Settings key with these fields defaulting to
  // `false` so 013 can wire its UI without a schema migration. Until 013 ships they have no
  // effect.
  ai_fallback_enabled: boolean;      // default false; owned by spec 013
  ai_model_downloaded: boolean;      // default false; owned by spec 013
  capture_message_bodies: boolean;   // publishable only; default false; gates spec 013's
                                      // side-channel closure (D-rev-13 / D-AI-2 in 013)
  first_run_completed: boolean;
}

export type BindingStatus = 'pending' | 'confirmed';

export interface ExtensionBinding {
  token: string;
  bound_at: string;       // ISO
  status: BindingStatus;  // D-rev-8 two-phase handshake
}

// Augments STORAGE_KEYS:
export const STORAGE_KEYS = {
  // …existing keys (spec 003/007/009)…
  LAST_SYNCED_AT: 'last_synced_at',
  SETTINGS: 'settings',
  BINDING: 'binding',
  // recovered_html is NOT a single key — it lives under per-id keys of the form
  //   `recovered_html_<history_id>`
  // so that the hot outbox payload stays small (~2KB/entry). D-rev-28.
} as const;

// Augments PipelineEvent (in-memory + on-wire shape):
export interface PipelineEvent {
  // …existing fields…
  history_id: string;                       // promoted to first-class (was OutboxEntry-only)
  source?: 'selectors' | 'ai-recovered';
  recovered_html?: string;                  // attached to outbound rows ONLY at sync-pull
                                             // time (publishable build) from the per-id
                                             // keyed store. Never persisted inline on
                                             // OutboxEntry. D-rev-28.
}
```

### Outbox cap (publishable)

Per D-rev-25 (revises D-rev-7), the publishable build's outbox has **no fixed cap and no
staleness aging**. Unsynced events accumulate indefinitely on the device until the user
syncs or manually clears. The effective ceiling is `chrome.storage.local`'s 10 MB quota,
which at ~2 KB per OutboxEntry (recovered_html lives elsewhere — D-rev-28) supports
roughly 5,000 unsynced events before triggering `STORAGE_QUOTA` (D-rev-11).

The internal build retains `OUTBOX_CAP=50`, `OUTBOX_MAX_ATTEMPTS=3`, and
`OUTBOX_STALE_AFTER_MS=7d` unchanged — there is a real webhook draining it, so the cap and
the staleness rule are load-bearing for that build.

`HistoryEntry`, `OutboxEntry`, `Severity`, `EventType`, all `BADGE_*` constants, `HISTORY_CAP`, `OUTBOX_CAP`, `OUTBOX_MAX_ATTEMPTS`, `OUTBOX_STALE_AFTER_MS` — unchanged.

A typed `storage.ts` facade wraps `chrome.storage.local` so both builds (and tests) read/write through the same shape. No raw `chrome.storage.local.get/set` calls outside the facade.

### D6. Side-panel scope (publishable)

The side panel has two regions:

1. **Unsynced events list** — renders up to 500 entries from the outbox in capture order
   (newest first). If the outbox holds more than 500 (rare; would imply >500 captures
   without a sync), the list paginates / virtualizes; older entries remain in storage,
   they just aren't all in the DOM. Each row: name, title, profile URL, event_type,
   `source` badge, capture timestamp, sync status ("Captured locally — needs sync"),
   and lazy-loaded `recovered_html` shown only on row expand (perf — D-rev-30).
2. **Recent activity strip** — renders HISTORY (cap `HISTORY_CAP=10` per spec 007) as a
   small "what just happened" widget. Resolved events (synced or error) flow through
   here; unsynced events appear in region 1 instead.

Synced events are not retained locally (D-rev-29 — backend is the synced archive). CSV
export covers everything currently on the device (unsynced + HISTORY).

### D7. CSV export

Both builds. Side-panel button (publishable) / popup button (internal). Background builds CSV → `chrome.downloads.download` with `data:` URL. Filename `pipeline-YYYY-MM-DD.csv`.

Columns:

```
captured_at, name, title, linkedin_url, event_type, message_text, source, recovered_html
```

`recovered_html` is empty unless `source === 'ai-recovered'`. `message_text` is empty when (publishable) `settings.capture_message_bodies === false`.

### D8. First-run modal (publishable only)

Triggered first time the side panel opens. Single screen, three points:

1. What we capture (name, title, profile URL of LinkedIn people you contact; *optionally* the message body, off by default).
2. Where it's stored (in this extension on your device only).
3. Where it goes (nothing leaves until you click Sync on app.cmcareersystems.com, in your existing session).

Plus the `capture_message_bodies` toggle with the "conversion-rate analysis" use case as the "why on" note. Default off. `settings.first_run_completed` flips to true on close.

### D9. Telemetry — none

No phone-home channel for extraction-failure rates. Recovery rates are deducible from the `source` field on rows that reach the backend.

---

## Manifests

### `pipeline-tracker/src/manifest.internal.json`

Matches today's `pipeline-tracker/src/manifest.json` on main — no behavior change beyond adding `downloads` for CSV export.

```json
{
  "manifest_version": 3,
  "name": "Pipeline Tracker",
  "version": "1.x.x",
  "permissions": ["storage", "alarms", "downloads"],
  "host_permissions": [
    "https://www.linkedin.com/*",
    "https://ktazhzplyhpqayjaghur.supabase.co/*"
  ],
  "content_scripts": [{
    "matches": ["https://www.linkedin.com/*"],
    "js": ["content.js"],
    "run_at": "document_idle"
  }],
  "background": { "service_worker": "background.js", "type": "module" },
  "action": {
    "default_popup": "popup/popup.html",
    "default_title": "Pipeline Tracker"
  },
  "icons": { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" }
}
```

### `pipeline-tracker/src/manifest.publishable.json`

```json
{
  "manifest_version": 3,
  "name": "Pipeline Tracker for LinkedIn",
  "version": "1.0.0",
  "key": "<stable dev key — locks extension ID>",
  "permissions": ["storage", "downloads", "sidePanel"],
  "host_permissions": ["https://www.linkedin.com/*"],
  "externally_connectable": {
    "matches": ["https://app.cmcareersystems.com/*"]
  },
  "content_scripts": [{
    "matches": ["https://www.linkedin.com/*"],
    "js": ["content.js"],
    "run_at": "document_idle"
  }],
  "background": { "service_worker": "background.js", "type": "module" },
  "side_panel": { "default_path": "sidepanel/index.html" },
  "action": { "default_title": "Pipeline Tracker — open side panel" },
  "icons": { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" }
}
```

Notes:

- No `alarms` — publishable build never drains autonomously.
- No supabase.co host permission.
- `key` locks the extension ID so the binding token survives Web Store builds.
- `aiLanguageModel` permission added at submission time if Chrome requires it (see §CI guards).
- `downloads` and `sidePanel` ship in v1.0 even if their first use is post-launch, to avoid permission-change re-review later.

---

## DestinationStrategy

```ts
// pipeline-tracker/src/destination.ts
export interface DestinationStrategy {
  onEventCaptured(event: PipelineEvent, historyId: string): Promise<void>;
}

// Internal build — wraps the existing outbox drain.
export class WebhookAutoPushStrategy implements DestinationStrategy {
  constructor(private readonly opts: {
    webhookUrl: string;
    storage: StorageFacade;
  }) {}
  async onEventCaptured(_event: PipelineEvent, _historyId: string): Promise<void> {
    // Enqueue happens upstream in background.ts. This is a hook the existing
    // drain trigger calls; no-op for now beyond drainImmediately() invocation.
  }
}

// Publishable build — sync is pulled by the app on user gesture.
export class AppSyncStrategy implements DestinationStrategy {
  async onEventCaptured(_event: PipelineEvent, _historyId: string): Promise<void> {
    // No-op.
  }
}
```

Both builds share the existing outbox + history + badge flow. The strategy abstracts only the *destination*; capture, enqueue, badge update, and history append are common code.

---

## Web Store posture (publishable only)

| Concern | Posture |
|---|---|
| Single purpose | "Log your own LinkedIn outreach activity into your CareerSystems pipeline." |
| Host permissions | `linkedin.com` only |
| Personally identifiable info | Yes (names, profile URLs of LinkedIn third parties) — disclosed |
| Personal communications | Only if user enables `capture_message_bodies` in the first-run modal (default off) — disclosed |
| Data transmitted | Only via user-initiated "Sync" on app.cmcareersystems.com, over their session, after explicit first-run binding |
| AI processing | On-device only; explicitly stated on listing |
| Trader/non-trader | **Trader** — extension is part of the CareerSystems commercial product; business address/contact on listing |
| Privacy policy | Required; covers data classification, retention (user-controlled via Clear All), AI processing (on-device, no transit), binding model, message-body opt-in |

---

## Sync contract (page-side, abbreviated)

```ts
// app.cmcareersystems.com page JS

const status = await fetch('/api/pipeline/binding-status').then(r => r.json());

// Probe — presence only (D-rev-27). No counts without token.
const probe = await new Promise(resolve =>
  chrome.runtime.sendMessage(EXT_ID, { type: 'ping' }, resolve));
if (!probe) { showInstallExtensionCTA(); return; }

if (!status.bindingToken) { showConnectExtensionCTA(); return; }

// Authed ping — returns counts iff token matches a confirmed binding (D-rev-27).
const counts = await new Promise(resolve =>
  chrome.runtime.sendMessage(EXT_ID,
    { type: 'ping', bindingToken: status.bindingToken }, resolve));
if (!counts.bound) { showReconnectExtensionCTA(); return; }
renderSyncButton({ unsyncedCount: counts.unsyncedCount });

// On user click — Sync
const { rows, syncedIds } = await new Promise(resolve =>
  chrome.runtime.sendMessage(EXT_ID,
    { type: 'sync-pull', bindingToken: status.bindingToken }, resolve));

await fetch('/api/pipeline/import', {
  method: 'POST',
  body: JSON.stringify({ rows }),
  // session cookie carries auth
});

await new Promise(resolve =>
  chrome.runtime.sendMessage(EXT_ID,
    { type: 'sync-ack', bindingToken: status.bindingToken, syncedIds }, resolve));
```

---

## CI guards

To enforce the invariants this spec depends on:

1. **Extraction logic isolation (I-1)** — `grep` for Card-classnamed symbols (`*Card`) in `pipeline-tracker/src/` returns zero matches outside `packages/scraping-core/`.
2. **No raw chrome.storage** — `grep -rn "chrome\.storage\.local\.\(get\|set\)" pipeline-tracker/src/` excluding `storage.ts` returns zero matches.
3. **No fetch from publishable bundle** — when `--target=publishable`, `build.ts` greps the bundled JS for `fetch(` / `XMLHttpRequest` outside an allow list. Any hit fails the build.
4. **AI Prompt API symbol isolation** — owned by spec 013. CI guard ensures
   `LanguageModel.{create,availability}` references only live in
   `packages/scraping-core/src/ai-fallback/`.
5. **Permission drift check** — owned by spec 013. Build-time check that
   `manifest.publishable.json` carries any Prompt API permission Chrome now requires.

---

## CSV format

```
captured_at,name,title,linkedin_url,event_type,message_text,source,recovered_html
2026-05-29T14:32:01Z,Jane Doe,VP Engineering,https://linkedin.com/in/janedoe,connection_request,"Hi Jane...",selectors,
2026-05-29T14:35:18Z,John Roe,Founder,https://linkedin.com/in/johnroe,direct_message,,ai-recovered,"<div>...</div>"
```

`recovered_html` is only populated for publishable-build rows where `source === 'ai-recovered'`
and the trimmed HTML is small (~2–8 KB typical, 16 KB cap per D-rev-16). It is read from the
per-id keyed store (`recovered_html_<history_id>`) at export time (D-rev-28). Internal-build
rows use spec-008 server-side extraction, so no client-side HTML carry-through.

---

## Implementation phases

Each phase ships as ONE PR sized to ~200-400 lines of diff (source + tests). The internal
flow must work after every phase — no half-states allowed.

Phase 0 has zero code diff; it's a baseline-sanity checklist that gates the rest.

### Per-PR workflow (mandatory for every phase in this spec)

Before opening a PR for any phase:

1. `pnpm typecheck && pnpm test && pnpm lint && pnpm format:check` — must be green.
2. **Run `/code-review --effort high` against the current diff.** Invokes the multi-angle
   reviewer skill on the local branch (no PR required). Address every CONFIRMED finding.
   Triage PLAUSIBLE findings — fix or document why you're deferring; never silently drop.
3. Re-run step 1 after the fixes.
4. Only THEN open the PR.

Established by spec 011 — see that spec's per-PR workflow note for the rationale (real
issues caught locally that would have shipped through PR review otherwise).

### Phase 0 — Branch sync + baseline sanity (no LoC; checklist PR)

Confirm the working branch has the union of:

- `pipeline-tracker/src/` from `origin/main` (background, content, popup, types, logger — cards
  moved to `@cs/scraping-core` per spec 011).
- Spec 011 fully merged: `packages/scraping-core/` resolves; `pipeline-tracker/src/content.ts`
  imports `extract`, `validate`, `Card` from `@cs/scraping-core`.
- Spec-007 badge/history wiring intact.
- Spec-009 outbox wiring intact.
- Spec-008 server-side AI extraction in `pipeline-tracker-webhook` (CareerSystems repo) intact;
  document the dependency.

Done when: `pipeline-tracker/dist-internal/` builds locally and the existing internal flow
works end-to-end against a test sheet. No code change.

### Phase 1 — Storage facade + Settings + ensureInitialized (~300 LoC)

- Create `pipeline-tracker/src/storage.ts` — typed facade over `chrome.storage.local`.
- Add `SETTINGS`, `LAST_SYNCED_AT` keys with defaults.
- `ensureInitialized()` per SW spin-up; `await`-ed at the top of every `onMessage` /
  `onMessageExternal` handler.
- CI guard #2 (no raw `chrome.storage.local.get/set` outside `storage.ts`).
- Tests: facade get/set round-trip; quota-exceeded path emits `STORAGE_QUOTA` history row
  (D-rev-11a); shape-mismatch resets to default (D-rev-11b); `ensureInitialized()` idempotent
  across spin-ups.

### Phase 2 — Binding shape + per-id recoveredHtml store hooks (~250 LoC)

- Add `BINDING` storage key + `ExtensionBinding` type with `status: 'pending' | 'confirmed'`.
- Storage facade gains `binding.get()`, `binding.set()`, `binding.clear()`.
- Storage facade gains `recoveredHtml.set(historyId, html)`, `.get(id)`, `.remove(id)` (per-id
  keys per D-rev-28). 16 KB cap enforced at persist boundary (defense in depth — spec 013 also
  enforces at strip time).
- No callers yet; spec 013 writes via these helpers, this spec's sync-pull/sync-ack reads via
  them in Phases 9-10.
- Tests: round-trip; 16 KB rejection; missing-key returns `null` cleanly.

### Phase 3 — Internal-build e2e regression test (~350 LoC)

Lock the working internal flow before the DestinationStrategy refactor touches it (D-rev-31).

- New `tests/unit/pipeline-tracker/background-drain.e2e.test.ts`: drives content → enqueue →
  background drain → mocked webhook → HistoryEntry resolved → outbox empty.
- Covers webhook 200, 400, 500, network failure (retry to `OUTBOX_MAX_ATTEMPTS`).
- Asserts webhook payload is byte-identical to the pre-refactor shape — this is the regression
  guard for Phase 4.
- Mock plumbing for `chrome.storage` + `fetch` lives in `tests/__mocks__/`.

Done when: test passes against current `background.ts` on `origin/main` and runs in CI.

### Phase 4 — Manifest split + DestinationStrategy (~400 LoC)

- Split `manifest.json` → `manifest.internal.json` + `manifest.publishable.json`.
- `build.ts` accepts `--target=internal|publishable`; selects manifest + UI bundle (popup vs
  sidepanel).
- Introduce `pipeline-tracker/src/destination.ts` with the `DestinationStrategy` interface.
- Existing background drain logic moves into `WebhookAutoPushStrategy`.
- `AppSyncStrategy` is a no-op shell (`onEventCaptured` resolves immediately).
- CI guard #3 (no `fetch(`/`XMLHttpRequest` in publishable bundle outside an allow list).
- Phase 3's e2e test must still pass — this is the regression gate.

Done when: both `dist-internal/` and `dist-publishable/` build. Internal flow unchanged
end-to-end and Phase 3's e2e test still green.

### Phase 5 — Side panel shell + badge logic (~350 LoC)

- `pipeline-tracker/src/sidepanel/index.html` + `sidepanel.ts` — list view scaffold.
- **`chrome.runtime.onInstalled` handler** in `background.ts` calls
  `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`. This is REQUIRED;
  there is no `openPanelOnActionClick` field in the manifest (despite older docs). Without
  this call, clicking the toolbar icon does nothing in the publishable build.
- Two regions per D6: unsynced events list (top-500 paginated) + recent-activity strip
  (HISTORY, cap 10).
- Publishable badge logic in `background.ts`:
  `setBadgeText(String(unsyncedCount || ''))` + `BADGE_COLOR_PENDING` (#9333ea) by default;
  error/partial override per spec 007 (D-rev-26).
- `recovered_html` is never rendered in the side panel — neither at list mount nor on row
  expand (D-rev-30). The panel shows structured fields only.
- Tests: `setPanelBehavior` called once on install; badge transitions across (no events, N
  unsynced, error present); list pagination boundary at 500; row click stub.

### Phase 6 — First-run modal + Settings UI shell (~300 LoC)

- `pipeline-tracker/src/sidepanel/first-run-modal.ts` per D8 + D-rev-17 (close button disabled
  until user interacts with `capture_message_bodies` toggle).
- `first_run_completed` flips on close.
- Settings UI surface (panel section) — `capture_message_bodies` toggle wired here. AI-related
  settings (`ai_fallback_enabled`, model-download flow) are stubbed but inactive; spec 013
  takes them over.
- Tests: modal renders on first open only; close gated on toggle interaction;
  `capture_message_bodies` persists.

### Phase 7 — Binding handshake + two-phase state machine (~350 LoC)

- "Connect to CareerSystems" button in side panel.
- `binding.token = crypto.randomUUID()`; `binding.status = 'pending'`.
- Long-lived port (D-rev-12) — `chrome.runtime.onConnectExternal` handler in
  `background.ts`. **Sender validation (defense in depth):** reject the port if
  `sender.origin !== 'https://app.cmcareersystems.com'` OR `!sender.tab?.id`. The
  `externally_connectable.matches` manifest entry already filters at the protocol level,
  but in-handler validation closes the gap if the entry is ever loosened.
- Extension stores the validated port keyed by `sender.tab.id`. Side panel resolves the
  active app tab's port and `postMessage({type: 'bind-offer', bindingToken})`.
- **SW lifecycle note:** opening the port does NOT keep the SW alive (Chrome 116+); only
  messages sent over it do. The 10 s rollback timer therefore lives in the **side-panel JS**
  (which stays alive as long as the panel is open), not in the SW. State machine transitions
  are persisted to `storage.binding.status` so a SW respawn picks up where it left off.
- 10 s rollback on no ack (D-rev-8): side panel clears `binding` and shows "Connection
  failed: timeout."
- App acks → `binding.status = 'confirmed'`; UI shows "Connected."
- Tests: pending → confirmed; pending → null on timeout (driven by side panel timer, not
  SW); port disconnect mid-handshake; disconnect button clears local binding; port from
  wrong origin is rejected at handler.

### Phase 8 — Multi-tab broadcast + rebind 3-choice protection (~300 LoC)

- D-rev-9: if multiple `app.cmcareersystems.com` tabs are open, broadcast `bind-offer` to all
  ports; first ack wins; later acks no-op after the port detects the binding is already
  `'confirmed'` via a `/binding-status` poll.
- Zero tabs → side panel shows "Open CareerSystems first" with a button calling
  `chrome.tabs.create`.
- D-rev-19: rebind when `binding.status === 'confirmed'` AND `unsyncedCount > 0` triggers a
  3-choice modal (sync to prior account first / delete outbox / move to new account); no
  default action.
- Tests: multi-tab race with explicit ordering control via fake timers; zero-tab empty state;
  each rebind choice's effect on storage.

### Phase 9 — Ping handler + sync-pull (~350 LoC)

- `onMessageExternal` registered in `background.ts` (publishable only).
- **Every handler entry validates `sender.origin === 'https://app.cmcareersystems.com'`**
  before doing anything else. Defense in depth alongside
  `externally_connectable.matches`. Reject with no response on origin mismatch.
- `ping` unbound → `{version, installed: true}`; bound + valid token →
  `{version, installed: true, eventCount, unsyncedCount, bound: true}`; bad token →
  `{installed: true, bound: false}` (D-rev-27).
- `sync-pull {bindingToken}` → token mismatch returns `{error: 'NOT_BOUND'}`; match returns
  `{rows: PipelineEvent[], syncedIds: string[]}`.
- For each row: lazily attach `recovered_html` from the per-id keyed store (D-rev-28). Stays
  empty until spec 013 ships.
- Idempotency: re-pull returns same rows (no mutation during pull).
- Tests: ping in each binding state; sync-pull token gating; sync-pull idempotent re-call;
  sync-pull excludes already-acked entries.

### Phase 10 — sync-ack + atomic removal + race tests (~400 LoC)

- `sync-ack {bindingToken, syncedIds}` — token mismatch returns `{error: 'NOT_BOUND'}`; match
  triggers atomic removal per D-rev-29:
  ```
  for id in syncedIds:
    outbox.remove(id)
    recoveredHtml.remove(id)
    history.resolve(id, {status: 'ok', message: 'Synced via app'})
  ```
- Unknown ids silently ignored (idempotent re-ack).
- Race tests:
  - Mid-flight capture (D-rev-23): event captured between sync-pull and sync-ack does NOT
    appear in `syncedIds`; remains unsynced for next pull.
  - sync-ack drop tolerated: next sync-pull returns same rows; backend dedupes on `history_id`
    (D-rev-18).
  - Concurrent sync-pull calls — second returns same rows; no double-ack possible.
- This is the largest phase; if it lands over 400 LoC, split atomic removal (one PR) from race
  tests (second PR).

### Phase 11 — CSV export + row-expand UI (~250 LoC)

- Side panel "Export CSV" button → background builds CSV via `data:` URL →
  `chrome.downloads.download` (filename `pipeline-YYYY-MM-DD.csv`).
- Columns per §CSV format.
- `recovered_html` column: empty unless `source === 'ai-recovered'` AND the per-id key
  exists; read from `recoveredHtml.get(historyId)` at CSV-build time only (D-rev-30).
- CSV escaping for commas/quotes/newlines.
- Side panel row click expands `<details>` showing **only structured fields** — name, title,
  profile URL, event type, captured timestamp, `source` badge, and `message_text` (if
  `capture_message_bodies` is on). `recovered_html` is NOT read or displayed (D-rev-30
  revised).
- Tests: column-format snapshots; escaping cases; CSV reads recovered_html from keyed
  store; row expand does NOT call `recoveredHtml.get()`.

### Phase 12 — Web Store packaging + privacy policy (no LoC; docs PR)

- Privacy policy draft (separate doc) covering: data classification, retention (user-controlled
  via Clear All), AI processing (delegated to spec 013 if shipping AI alongside), binding model,
  message-body opt-in, residual risk (D-rev-14).
- Listing assets (screenshots, descriptions, icons).
- Submission checklist.
- CI guard #5 — permission drift check (owned by spec 013 if AI ships; otherwise stub).

Done when: all guards green; manifest valid for Web Store; listing draft reviewed.

---

## Open questions (revised)

1. **Long-term role of `linkedin-tracker/`** — out of scope here. Tracked separately. The two extensions coexist in this spec; convergence is a future decision.
2. **App-team scope of work** — `/api/pipeline/bind-extension`, `/api/pipeline/binding-status`, `/api/pipeline/import`, `/api/pipeline/unbind-extension` are required on the CareerSystems side. Tracked separately as a CareerSystems spec.
3. **Whether the publishable build also exposes `chrome.alarms`-based drain** — currently no (D1). If ambient sync without re-opening the app is desired, this becomes a follow-up.

---

## Decisions log

### From Step-0 / Section 1 (Architecture)

- **D-rev-1.** Sync uses explicit ID set, not time watermark. (review issue 1A)
- **D-rev-2.** Sync-pull / sync-ack require a `bindingToken` established via a side-panel-initiated handshake. (review issue 2A)
- **D-rev-3.** Spec is rebased on origin/main; renumbered to 010; references 006/007/008/009 as baseline. (review issue 3A)
- **D-rev-4.** AI extraction is layered: on-device first (this spec); server-side fallback (spec 008) on internal build only. (review issue 4A)
- **D-rev-5.** Storage schema extends spec 007 + spec 009 rather than replacing them; `OUTBOX`, `HISTORY`, `Severity`, badge constants all retained. (review issue 5A)

### From Section 2 (Error & Rescue Map)

- **D-rev-6 (2.1A).** Outbox enqueue happens in the **content script** before `chrome.runtime.sendMessage`, exactly as spec 009 specifies. The §Architecture diagram's `onMessage(event)` block does NOT call `storage.outbox.enqueue` — the entry already exists by the time the background receives the message. Background's job is to drain, classify, and update the existing pending `HistoryEntry` in place. This preserves the spec-009 durability guarantee against SW-not-alive / extension-context-invalidated / channel-closed failures.
- **D-rev-7 (2.2A) — SUPERSEDED by D-rev-25.** Original: publishable outbox stayed at
  `OUTBOX_CAP=50` with refuse-at-cap semantics. Revised per the plan-eng-review decision on
  Issue 1: unsynced events accumulate uncapped (effective ceiling is `chrome.storage.local`
  quota, not a hard count). See D-rev-25 for the replacement design.
- **D-rev-8 (2.3A).** Binding handshake is two-phase: `storage.binding = {token, bound_at, status: 'pending'}` initially. `sync-pull`/`sync-ack` require `status === 'confirmed'`. App ack within 10s flips to `confirmed`; timeout/error rolls back to `null`. UI states: "Connecting…" / "Connected" / "Connection failed: <reason>".
- **D-rev-9 (2.4A).** `bind-offer` is broadcast to **all** `app.cmcareersystems.com` tabs (first ack wins; remainder no-op after a brief delay by polling `/binding-status`). If zero tabs match, side panel shows "Open CareerSystems first" with a button calling `chrome.tabs.create`.
- **D-rev-10 (2.5A) — MOVED to [spec 013 D-AI-1](013-pipeline-tracker-ai-fallback.md#decisions-log).** `recover()`'s never-throws guarantee is owned by the AI fallback spec.
- **D-rev-11 (2.6A).** Storage facade rules: (a) quota-exceeded on `set` surfaces a `HistoryEntry { status: 'error', code: 'STORAGE_QUOTA' }` for the affected event; further capture refused until user clears history. (b) Every `get` validates against a schema; on shape mismatch, the affected key resets to default + logs a warning. (c) `ensureInitialized()` runs once per SW spin-up to fill missing keys with defaults — idempotent migration.

### From Section 3 (Security & Threat Model)

- **D-rev-12 (3.1A).** Bind-offer delivery uses a **long-lived port**, not `chrome.tabs.sendMessage`. App page on load calls `chrome.runtime.connect(EXT_ID, {name: 'pipeline-tracker-app'})`. Extension stores the port keyed by `sender.tab.id`. Side panel "Connect" looks up the port and `port.postMessage({type: 'bind-offer', bindingToken})`. Keeps the publishable manifest to linkedin.com-only host permissions (no content script on the app domain).
- **D-rev-13 (3.2A) — MOVED to [spec 013 D-AI-2](013-pipeline-tracker-ai-fallback.md#decisions-log).** Side-channel closure on messenger cards lives with the AI fallback spec.
- **D-rev-14 (3.3A).** `bindingToken` theft via XSS / sibling extension with `host_permissions` on the app origin is fundamentally possible — `chrome.runtime.onMessageExternal`'s `sender` cannot distinguish callers from sibling content scripts. Documented as residual risk in §Web Store posture / privacy policy. Per-cycle token rotation tracked as follow-up spec, not v1.0.
- **D-rev-15 (3.4A) — MOVED to [spec 013 D-AI-3](013-pipeline-tracker-ai-fallback.md#decisions-log).** 10 s `AbortSignal` timeout on each `prompt()` call.
- **D-rev-16 (3.5A) — MOVED to [spec 013 D-AI-4](013-pipeline-tracker-ai-fallback.md#decisions-log).** 16 KB cap on `recovered_html` after strip. This spec uses the cap value at the storage facade's persist boundary but does not own it.
- **D-rev-17 (3.6A).** First-run modal close button is disabled until the user explicitly interacts with the `capture_message_bodies` toggle. Prevents accidental opt-in by dismissing the modal without reading the choice.

### From Section 4 (Data Flow & Interaction Edge Cases)

- **D-rev-18 (4.1A).** `/api/pipeline/import` MUST be idempotent on `PipelineEvent.history_id`. This is a HARD load-bearing requirement of the app-side endpoint contract — duplicated rows on the extension side (concurrent syncs, dropped sync-ack) rely on the backend deduplicating. Stated normatively in §App backend contract.
- **D-rev-19 (4.2A).** Rebind protection: when a rebind would replace an existing `binding.status === 'confirmed'` AND `unsyncedCount > 0`, the side panel surfaces a 3-choice modal before clearing the prior binding: (a) sync to the previous account first; (b) delete the outbox; (c) move events to the new account. No default. Without this prompt, a different CareerSystems user logging in on the same Chrome profile could silently receive the prior user's outbox.
- **D-rev-20 (4.3A).** Spec-009 "extension context invalidated" banner inherits verbatim. Content script detects `chrome.runtime.id === undefined` after MutationObserver fires; surfaces a banner prompting the user to reload the LinkedIn tab. Identical in both builds.
- **D-rev-21 (4.4A).** Coexistence with `linkedin-tracker/`: if both extensions are installed in the same Chrome profile, events are double-captured (one to each extension's own outbox). Acceptable during the convergence period; long-term direction (retire one) tracked in spec 011 / Open Questions.
- **D-rev-22 (4.5A).** Dedup guard (existing 500ms `(name, ts)` window for click+Enter double-fire) lives in the content script with thresholds imported from `@cs/scraping-core` constants. Identical across builds.
- **D-rev-23 (4.7A).** Sync-ack drop tolerated: if the app POSTs successfully to `/api/pipeline/import` but the user closes the tab before `sync-ack` fires, the outbox shows unsynced; next sync-pull returns the same rows; app re-POSTs; backend deduplicates per D-rev-18. No data loss; at most one duplicate POST per dropped ack.

### From plan-eng-review of this spec (Section 5) <a id="section-from-publishable-review"></a>

- **D-rev-24.** **Scraping-core extraction is a prereq spec, not part of this spec.** Phase 1
  of the original draft (move `*-card.ts` into `packages/scraping-core/`) is excised. It now
  lives in its own spec because (a) it requires turning the repo into a pnpm workspace, which
  touches every existing build path, and (b) it is independently valuable. This spec begins
  with the prereq complete. See the new "Prerequisites" section near the top.

- **D-rev-25 (revises D-rev-7).** **Publishable outbox is uncapped on the device.** No
  `OUTBOX_CAP` for the publishable build; no `OUTBOX_STALE_AFTER_MS` aging. Unsynced events
  accumulate in `chrome.storage.local` until the user syncs or manually clears. Side panel
  paginates / virtualizes at 500 rendered rows. The effective ceiling is the 10 MB
  `chrome.storage.local` quota, which at ~2 KB/entry supports ~5,000 unsynced events before
  `STORAGE_QUOTA` (D-rev-11) triggers refuse-at-quota.

  *Why:* the original refuse-at-50 design forces the user into the app to clear capacity
  during heavy outreach weeks. The user explicitly wants "keep all events that are not
  synced; render up to 500."

  *Internal build is unchanged:* it keeps `OUTBOX_CAP=50`, `OUTBOX_MAX_ATTEMPTS=3`, and
  staleness aging because there is a real webhook actively draining it.

- **D-rev-26.** **Publishable badge surfaces unsynced count.** The badge displays
  `unsyncedCount` (text) in `BADGE_COLOR_PENDING` (#9333ea) between captures and the next
  sync. Error/partial events override per spec 007 (red / amber). Zero unsynced + no
  outstanding errors clears the badge.

  *Why:* in the publishable build the drain is user-gestured. Without a toolbar signal, the
  user has no toolbar-level cue that they have captured-but-unsynced events. This delineates
  "captured locally" from "synced to backend" without requiring the side panel be open.

- **D-rev-27.** **`ping` reveals presence only when unbound; counts require token match.**
  Unauthenticated `{type: 'ping'}` from any code on `app.cmcareersystems.com` (XSS,
  third-party scripts, sibling extension content scripts) returns `{version, installed: true}`
  — enough to render "Connect" CTA, no PII. `{type: 'ping', bindingToken}` returns counts only
  if the token matches `storage.binding.token` AND `binding.status === 'confirmed'`; bad
  token returns `{installed: true, bound: false}`.

  *Why:* the original D2 design left `eventCount` / `unsyncedCount` (effectively outreach
  volume) readable by any caller on the app origin. This is tightened without changing the
  app-side UX — the app already runs an authenticated `/api/pipeline/binding-status` round
  trip to know whether to render the "Connect" or "Sync" CTA, so it can pass the token on
  ping the same way it does on sync-pull/ack.

- **D-rev-28.** **`recovered_html` lives in a separate per-id keyed store.** Storage key
  shape: `recovered_html_<history_id>`. NOT inlined on `OutboxEntry`. Read lazily by
  `sync-pull` (attaching to the outbound `PipelineEvent.recovered_html` for transit only) and
  by CSV export. Removed by `sync-ack` at the same time the outbox entry is removed.

  *Why:* per D-rev-16 each `recovered_html` is up to 16 KB. Inlining it on `OutboxEntry`
  would mean every capture/render of the outbox pays 16 KB I/O. With the uncapped outbox
  (D-rev-25), a user with 600 AI-recovered captures would hit the 10 MB quota in
  weeks. Splitting the heavy payload into per-id keys keeps the hot outbox payload ~2 KB and
  pushes the quota ceiling to ~5,000 entries.

- **D-rev-29.** **`sync-ack` removes from local storage; backend is the synced archive.** The
  spec text `storage.outbox.markSynced(id)` (originally undefined) resolves to:
  `outbox.remove(id) + recoveredHtml.remove(id) + history.resolve(id, 'ok')`. The device
  retains no synced-event archive. `last_synced_at` continues to be tracked.

  *Why:* the user explicitly chose this in plan review (Issue CQ-1). The backend already
  holds synced rows (per `/api/pipeline/import`); duplicating them on the device costs
  storage with no UX benefit. Side-panel UX is built around "unsynced needs your attention"
  + "HISTORY shows last 10 resolved" — synced-archive browsing happens in the app.

- **D-rev-30.** **`recovered_html` is NOT exposed in the side panel.** The side panel never
  reads or displays `recovered_html` — not at list mount, not on row expand. Row expand
  shows only the structured fields the user can act on (name, title, profile URL, event
  type, message text if `capture_message_bodies` is on, captured timestamp, `source`
  badge). The `recovered_html_<history_id>` keyed store is consulted only by:

  - `sync-pull` (re-attaches HTML to the wire-format `PipelineEvent` for transit to the app)
  - CSV export (writes the column from the keyed store)

  *Why:* the HTML evidence is a payload for the backend / analyst, not a UI artifact. Users
  cannot do anything useful with it on the device, and rendering it inflates DOM, leaks
  message bodies (when `capture_message_bodies` is off, the strip-at-persist closure means
  there's nothing to show anyway — but absent that, rendering would re-open the side
  channel D-rev-13 closed). Single principle: HTML stays in cold storage; the panel shows
  fields.

- **D-rev-31.** **Phase 3 e2e regression test for the internal drain.** Before the
  `DestinationStrategy` refactor (Phase 4 in the current plan) lands, an end-to-end test of the
  internal flow (content → enqueue → background drain → mocked webhook → resolve) must exist
  and pass on `origin/main`'s current implementation. This test acts as the regression guard
  for Phase 4.

  *Why:* the spec promises "Zero behavior change vs. today" for the internal build, but Phase 4
  wraps the working `drainOutbox()` in a new strategy interface — a real refactor risk for the
  only paying-clients flow. Existing `tests/unit/pipeline-tracker/` exercises card extraction,
  not the full POST → response classify → HistoryEntry resolve cycle.

- **D-rev-32 — MOVED to [spec 013 D-AI-5](013-pipeline-tracker-ai-fallback.md#decisions-log).**
  Per-error-mode tests + golden-fixture prompt tests live with the AI fallback spec.

---

## App backend contract (load-bearing requirements)

These constraints are required of the CareerSystems-app side. The extension's correctness depends on them; track in a separate CareerSystems-side spec.

- `POST /api/pipeline/bind-extension` — session-cookie-authed; accepts `{bindingToken}`; stores on user record; idempotent.
- `GET /api/pipeline/binding-status` — session-cookie-authed; returns `{bindingToken: string | null}`.
- `POST /api/pipeline/unbind-extension` — session-cookie-authed; clears stored token.
- `POST /api/pipeline/import` — session-cookie-authed; accepts `{rows: PipelineEvent[]}`. **MUST be idempotent on `PipelineEvent.history_id`** — duplicate `history_id`s in concurrent / retried requests are NO-OPS, not duplicate inserts.

---

## Threat model summary (publishable build)

| Threat | Mitigation | Residual |
|---|---|---|
| Page on app origin reads outbox without consent | D3 binding handshake (D-rev-2 / D-rev-8 / D-rev-12) | None during normal operation |
| Page on app origin reads unsynced count without consent (ping leak) | D-rev-27: unbound ping returns presence only; counts require token | None during normal operation |
| XSS on app.cmcareersystems.com steals `bindingToken` | bindingToken is effectively a bearer credential post-bind | Yes — documented (D-rev-14). Follow-ups: per-sync rotation; opt-in `accepts_tls_channel_id` for cryptographic sender identity (see Best-practice references). |
| Sibling browser extension with host perms on app origin calls sync-pull | Same as XSS — sender cannot be distinguished by `sender.origin` alone | Yes — documented (D-rev-14). TLS channel ID would help; tracked as follow-up. |
| Storage exfil via DOM access from LinkedIn page | `chrome.storage.local` not reachable from web context | None |
| Capture toggle bypass via `recovered_html` side channel | Strip messenger HTML when toggle off (D-rev-13) | None |
| Capture hang due to slow on-device model | 10s `AbortSignal` (D-rev-15) | None |
| Silent data loss on SW-not-alive sendMessage | Content-side enqueue (D-rev-6) | None |
| Silent data loss on outbox overflow | Refuse-at-cap (D-rev-7) | None — capture is blocked loudly |
| Wrong-account leak after rebind | Pre-rebind 3-choice modal (D-rev-19) | None |
| Concurrent sync duplicates | Idempotent backend on `history_id` (D-rev-18) | Depends on backend correctness |

---

## Open questions (revised again)

1. **Long-term role of `linkedin-tracker/`** — out of scope. Tracked in a future spec.
2. **App-team scope of work** — see §App backend contract. Tracked separately on the CareerSystems side.
3. **Ambient sync via `chrome.alarms`** — publishable build currently has no autonomous drain. Adding it would let the extension push events without the user opening the app, at the cost of a permission disclosure ("runs in the background"). Deferred.
4. **bindingToken rotation** — tracked as follow-up; not in v1.0 per D-rev-14.
5. **Dual-extension installation experience** — see D-rev-21. Convergence direction TBD.

---

## Best-practice references

Implementers MUST consult these before each phase. Memory notes live under
`/home/agent/.claude/projects/.../memory/`; verify currency at implementation time.

| Topic | Memory note | Applies to phases |
|---|---|---|
| MV3 SW lifecycle (30 s idle, port-open ≠ keepalive) | `chrome-mv3-sw-lifecycle` | 1, 3, 4, 7, 9-10 |
| `chrome.sidePanel` — `setPanelBehavior` is code-only | `chrome-side-panel` | 5 |
| `externally_connectable` + MessageSender validation | `chrome-externally-connectable` | 7, 8, 9, 10 |
| `chrome.storage.local` — 10 MB quota, atomicity, hot/cold split | `chrome-storage` | 1, 2, 10 |
| Web Store program policy + privacy disclosure | `chrome-web-store-policy` | 12 |
| pnpm + TS project references | `pnpm-typescript-monorepo` | covered by prereq spec 011 |

Key consequences already encoded in this spec:

- **`setPanelBehavior` is set in `onInstalled`**, not in the manifest (Phase 5).
- **Port open does NOT keep the SW alive** (Chrome 116+) — the binding 10 s rollback timer
  lives in the side panel, not the SW; binding state machine is persisted to storage so a
  SW respawn picks up where it left off (Phase 7).
- **Explicit `sender.origin` checks** in every `onMessageExternal` and `onConnectExternal`
  handler — defense in depth alongside `externally_connectable.matches` (Phases 7, 9).
- **`accepts_tls_channel_id`** is a future hardening option for `bindingToken` rotation;
  tracked as a TODO follow-up (D-rev-14).

---

Remaining plan-ceo-review sections (5: Code Quality; 6: Tests; 7: Performance; 8: Observability; 9: Deployment; 10: Long-term Trajectory) have not been run against this spec.
