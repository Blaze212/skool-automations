# Pipeline Tracker — Shared Side Panel (Internal Build Convergence)

**Status:** Draft
**Owner:** Barton Holdridge
**Last updated:** 2026-05-29

**Related (must be read first):**

- [006-pipeline-tracker.md](006-pipeline-tracker.md) — current internal extension; defines the
  popup UI (`popup/popup.html`, `popup/popup.ts`) that this spec retires
- [007-pipeline-tracker-result-feedback.md](007-pipeline-tracker-result-feedback.md) —
  badge + popup history; defines `HistoryEntry`, `Severity`, the "Recent activity" list
- [009-pipeline-tracker-outbox-queue.md](009-pipeline-tracker-outbox-queue.md) — outbox + the
  internal `WebhookAutoPushStrategy` drain trigger
- [012-pipeline-tracker-publishable.md](012-pipeline-tracker-publishable.md) — **prereq**:
  delivers the side panel UI (`sidepanel/`), the `DestinationStrategy` abstraction, and the
  badge logic that this spec reuses for the internal build

**Companion follow-on:**

- [013-pipeline-tracker-ai-fallback.md](013-pipeline-tracker-ai-fallback.md) — independent;
  AI fallback toggle appears in the shared settings surface and works in both builds.

---

## Objective

Retire `pipeline-tracker/src/popup/` and have the **internal build adopt the same side panel**
as the publishable build (spec 012). One UI. Two builds. The only build-time difference
remains the `DestinationStrategy` — internal autosends to the webhook, publishable waits for
user-gestured sync.

The user-visible result: a fractional client opening the internal extension sees the same
left-of-tab side panel as a Web Store user, with the same list of captures, the same
settings, the same "Export CSV." The only visible difference is a small "Auto-sync: on"
indicator instead of a "Connect to CareerSystems" / "Sync" button.

This reduces the codebase to one UI surface, one rendering path, one set of UI tests, and
one mental model for users who use both builds.

---

## Non-goals

- No change to either build's destination behavior. Internal still autopushes to the
  webhook; publishable still waits for user-gestured sync.
- No change to the existing `pipeline-tracker-webhook` contract or the People-sheet upsert
  flow.
- Not retiring `linkedin-tracker/` (tracked separately).
- No change to spec 013's AI fallback surface — the settings UI it adds works in either
  build's side panel without modification.

---

## Why now / why not sooner

The publishable build (spec 012) builds a richer UI than the existing internal popup: list
view with pagination, settings, first-run modal, CSV export, badge state machine. Keeping
two UIs means:

- Every UI bug fix has to ship twice.
- Every new feature (e.g. CSV-column tweaks, settings additions) ships twice or diverges.
- Tests duplicate.

The original spec 006 used a popup because the internal build pre-dated `chrome.sidePanel`.
That constraint is gone. Convergence is a pure code reduction — no user-facing regression.

Doing it as a *follow-up* spec (rather than folding it into 012) keeps spec 012's risk
surface tight: 012 ships the side panel for the publishable build only, where it has to
exist; this spec retires the popup independently once 012's panel is proven.

---

## What stays the same (internal build)

The internal build keeps:

- `WebhookAutoPushStrategy` from spec 012 Phase 4 — auto-drains the outbox to
  `pipeline-tracker-webhook` on every capture.
- `chrome.alarms` keep-warm + on-capture drain triggers (existing).
- The webhook contract, response classification, badge color logic (ok/partial/error per
  spec 007).
- The Supabase service-role host permission in `manifest.internal.json`.
- `OUTBOX_CAP=50`, `OUTBOX_MAX_ATTEMPTS=3`, `OUTBOX_STALE_AFTER_MS=7d` from spec 009.

What changes: the **UI surface** moves from `popup/` to `sidepanel/`. That's it.

---

## What the user sees

### Internal build today (popup, ~400px wide, transient)

```
┌─────────────────────────────┐
│  Pipeline Tracker           │
│                             │
│  API key: ●●●●●●●●●●  [Set] │
│  Last logged: 2:03 PM       │
│                             │
│  ─── Recent activity ───    │
│   ✓ 2:00 PM Jane …          │
│   ✓ 1:55 PM John …          │
│   ⚠ 1:48 PM Lisa …          │
│   [Clear history]           │
│                             │
└─────────────────────────────┘
```

### Internal build after this spec (side panel, persistent)

```
┌──────────────────────────────────────────────────────┐
│  Pipeline Tracker            Auto-sync ✓ to webhook  │
│                                                      │
│  ─── Last 24h ─────────────────────────────          │
│  37 captures sent · 1 partial · 0 errors             │
│                                                      │
│  ─── Recent activity ─────────────────────────       │
│   ✓ Jane Doe       2:03 PM    Connection request    │
│     Logged                                           │
│   ✓ John Roe       1:58 PM    Direct message        │
│     Logged                                           │
│   ⚠ Lisa Park      1:48 PM    Connection request    │
│     Missing required field: title                   │
│   …last 10…                                          │
│                                                      │
│  Settings ▾  ·  Export CSV  ·  Help                 │
└──────────────────────────────────────────────────────┘
```

The publishable build's side panel (spec 012) for comparison:

```
┌──────────────────────────────────────────────────────┐
│  Pipeline Tracker                  ✓ Connected       │
│                                                      │
│  7 captures awaiting sync                            │
│  [ Open CareerSystems to sync ]                      │
│                                                      │
│  ─── Unsynced events ─────────────────────────       │
│  …                                                   │
│  ─── Recent activity ─────────────────────────       │
│  …                                                   │
│  Settings ▾  ·  Export CSV  ·  Disconnect           │
└──────────────────────────────────────────────────────┘
```

Same chrome. Same regions. Only the header strip + the absence of an unsynced list differs.

---

## What differs in the shared panel

A small set of conditional rendering driven by `BUILD_TARGET`:

| Region | Internal build | Publishable build |
|---|---|---|
| Header status strip | "Auto-sync ✓ to webhook" + last 24h roll-up (37 sent / 1 partial / 0 errors) | "✓ Connected" / "Not connected" + unsynced count |
| Unsynced events list | **Hidden** — internal never has unsynced events (autopush succeeds or fails, both surface in history) | Shown with top-500 paginated |
| Big primary CTA | **None** — autosync is silent | "Open CareerSystems to sync" |
| API key field in Settings | Shown ("Set" / "Rotate") — required for webhook auth | Hidden — no API key in publishable |
| "Connect to CareerSystems" / Disconnect | Hidden | Shown |
| First-run modal | **Reduced**: capture_message_bodies is irrelevant (internal webhook handles its own data sensitivity); only the "Welcome" copy + AI fallback opt-in remain | Full first-run flow per spec 012 D8 |
| Recent activity (HISTORY, cap 10) | Same | Same |
| Settings | API key + debug mode (existing) + AI fallback toggle (from spec 013) | capture_message_bodies + AI fallback toggle |
| Export CSV | Same; `recovered_html` empty for internal (server-side AI per spec 008 means no client-side HTML carry) | Same |

The internal build's API-key entry surface migrates from the popup into the side panel's
Settings section verbatim.

`BUILD_TARGET` is the same constant `build.ts` already passes through esbuild's `define`
(used for the manifest selection in spec 012 Phase 4). UI components branch on it.

---

## Architecture

```
                    ┌─────────────────────────────────────┐
                    │  sidepanel/index.html               │
                    │  sidepanel/sidepanel.ts             │
                    │    • renders header strip           │
                    │    • renders unsynced (publishable) │
                    │    • renders HISTORY strip          │
                    │    • renders Settings               │
                    │    • renders Export CSV button      │
                    │  All branches gate on BUILD_TARGET. │
                    └─────────────────────────────────────┘
                              ↑                  ↑
                              │                  │
                          chrome.storage    chrome.runtime
                          (HISTORY,         .sendMessage
                          OUTBOX, SETTINGS) (export CSV, AI toggle)
                              ↑                  ↑
                              │                  │
                    ┌─────────────────────────────────────┐
                    │  background.ts (one file, two       │
                    │  destination strategies — spec 012) │
                    │                                     │
                    │  INTERNAL:    WebhookAutoPushStrategy
                    │  PUBLISHABLE: AppSyncStrategy        │
                    └─────────────────────────────────────┘
```

There is one `sidepanel.ts`. One UI test file. One CSS bundle. Two manifests still point to
it.

---

## Implementation phases

Each phase ships as ONE PR sized to ~200-400 lines of diff. The internal extension flow
must work after every phase — no half-states.

### Phase 1 — Internal manifest gains side panel; popup stays as fallback (~250 LoC)

- `manifest.internal.json` adds the `"sidePanel"` permission + `"side_panel": {"default_path":
  "sidepanel/index.html"}`.
- Keep `"action": {"default_popup": "popup/popup.html"}` for this phase — both surfaces
  exist; user can use either.
- `background.ts onInstalled` handler now also calls
  `chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: false})` for the internal
  build (clicking the icon keeps opening the popup, not the panel).
- `build.ts` updated to copy `sidepanel/` into `dist-internal/` too (was publishable-only).
- Tests: manifest valid; side panel opens via `chrome.sidePanel.open()` programmatically;
  popup still works.

Done when: both the popup and the side panel are available in the internal build. No user
forced over yet.

### Phase 2 — Side panel header strip + conditional rendering (~350 LoC)

- `sidepanel.ts` branches on `BUILD_TARGET`:
  - Internal: header shows "Auto-sync ✓ to webhook · Last 24h: 37 sent / 1 partial / 0
    errors." The 24h roll-up reads HISTORY (cap 10 still applies — roll-up is "of the rows
    we've kept") plus a counter in storage if we want a true 24h window (defer if HISTORY
    is enough for the v1 internal user).
  - Publishable: existing header from spec 012 Phase 5.
- Hide the unsynced-events region in the internal build (it's always empty; rendering
  empty state is noise).
- Tests: each branch renders the correct header; conditional region presence per build.

### Phase 3 — Settings section: API-key entry + debug-mode toggle migrated from popup (~300 LoC)

- Internal-only settings: API key field (`Set` / `Rotate` buttons) + debug mode toggle
  (both currently in popup/popup.ts).
- Publishable-only settings: capture_message_bodies (already in spec 012 Phase 6).
- Both-builds settings: AI fallback toggle (added by spec 013 Phase 6).
- Move API-key storage I/O from `popup.ts` into the shared storage facade (it should
  already be there from spec 012 Phase 1 — verify; refactor if not).
- Tests: API-key set / rotate; debug-mode toggle persists; build-target gating.

### Phase 4 — First-run flow gating for internal (~200 LoC)

- Reduce the internal first-run modal to a single-screen welcome: no
  `capture_message_bodies` toggle (irrelevant to webhook flow), no "Connect to
  CareerSystems" CTA (no binding).
- Internal first run shows: "Welcome — this captures your LinkedIn outreach and pushes it
  to your pipeline sheet via the configured webhook. Enter your API key below to start."
- `settings.first_run_completed` flips on close per spec 012 D8; same key, same semantics.
- Tests: internal first-run modal renders the reduced shape; flips
  `first_run_completed`; subsequent opens skip.

### Phase 5 — Retire the popup (~150 LoC)

- Remove `manifest.internal.json` `"default_popup"`.
- Update `onInstalled` to call
  `chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: true})` for the internal
  build (toolbar icon now opens the panel, matching publishable).
- Delete `pipeline-tracker/src/popup/` and `tests/unit/pipeline-tracker/popup.test.ts`.
- Update `build.ts` to stop bundling popup for internal.
- Update memory note `chrome-side-panel.md` reference if needed.
- Tests: popup file is gone; toolbar icon opens panel; all `popup.test.ts` cases either
  pass at their migrated `sidepanel.test.ts` location or are deleted as duplicates.

Done when: zero references to `popup/` in either build; both builds use only the side
panel.

---

## Migration / rollout

Five sequential PRs. Each PR ships a working internal build (popup OR panel works in
Phases 1-4; only panel works after Phase 5).

The popup retirement (Phase 5) is the breaking change for the internal user — they need to
know "the toolbar icon now opens a side panel instead of a popup." Roll-out steps:

1. Phase 1-4 ship over a week; internal users opt into the panel by opening it (via
   `chrome://extensions` "Open side panel" or `chrome.sidePanel.open()`).
2. Send a Slack note to fractional clients before Phase 5 lands: "tomorrow's update moves
   the popup into a side panel — toolbar click will open it in the right sidebar instead
   of a small popup."
3. Phase 5 ships. If anyone complains, the rollback is reverting Phase 5 — popup files
   stay in git history.

No version bump beyond the regular point release. No data migration. Storage shape
unchanged.

---

## Acceptance criteria

1. After Phase 5, `pipeline-tracker/src/popup/` does not exist.
2. Internal build: clicking the toolbar icon opens the side panel.
3. Internal build: API-key entry + debug-mode toggle live in the side panel's Settings
   section.
4. Internal build: header strip shows "Auto-sync ✓ to webhook" + last 24h roll-up.
5. Internal build: capture → autopush still works end-to-end (existing internal e2e test
   from spec 012 Phase 3 still green).
6. Publishable build: zero behavior change vs. spec 012's shipped panel.
7. Single `sidepanel.ts` source file; build-target conditional rendering is the only
   per-build difference in the panel code.

---

## Best-practice references

See spec 012's "Best-practice references" section. Same memory notes apply (chrome.sidePanel,
MV3 SW lifecycle, chrome.storage). No new APIs introduced.

---

## Open questions

1. **"Last 24h" header roll-up — counted from HISTORY (cap 10) or from a new counter?**
   HISTORY caps at 10 entries, so for a heavy user that's not 24 h of data. A dedicated
   24h counter in `chrome.storage.local` (incremented on each drain outcome, expired
   nightly) is a small addition. Defer until Phase 2 dogfooding reveals whether HISTORY
   suffices for the v1 read.
2. **Should the internal build also gain a manual "Sync now" button** (i.e. force-drain
   the outbox even though autosync already does it)? Useful for debugging; not needed for
   production. Defer.
3. **Side panel global vs per-tab** — current design is global (same panel everywhere).
   Per-tab would let us render a "you're on LinkedIn, capture is armed" indicator on
   LinkedIn tabs vs a "open LinkedIn to capture" hint on other tabs. Probably worth it as
   a Phase 6 follow-up.
