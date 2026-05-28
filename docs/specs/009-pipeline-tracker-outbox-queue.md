# Pipeline Tracker — Outbox Queue for Service Worker Reliability

**Status:** Draft
**Owner:** Barton Holdridge
**Last updated:** 2026-05-27
**Related:** `006-pipeline-tracker.md`, `007-pipeline-tracker-result-feedback.md`

## Problem

Captured LinkedIn events sometimes silently fail to reach the backend. The user sees no error in
the popup history, the badge stays clear, and the row never appears in the sheet — the event is
simply gone.

Root cause is the Chrome MV3 service worker lifecycle. The background worker shuts down after
~30 seconds of inactivity (by design). When the next event fires:

1. `content.ts:354` calls `chrome.runtime.sendMessage(event)` as fire-and-forget — the returned
   promise is never awaited.
2. If the worker is still spinning up, or the message port closes before a response, the rejection
   goes to an unhandled promise. `chrome.runtime.lastError` is never checked.
3. The `try/catch` in `sendEvent` (`content.ts:352-359`) only catches **synchronous** throws like
   "Extension context invalidated." Async channel-closed errors slip through.
4. No persistence — once a message is dropped in flight, there is no record it ever existed.

A secondary failure mode: when Chrome updates or reloads the extension, the content script's
`chrome.runtime` handle in any open LinkedIn tab becomes invalid. Every subsequent `sendMessage`
from that tab throws synchronously until the tab is reloaded. Today the warning gets swallowed and
the user has no indication that the tab is now "dead."

Why no errors in logs: service worker `console.log` output only persists while the worker is
alive. After a respawn, prior logs are gone from devtools. Dropped messages never reach the
`onMessage` listener, so `handleMessage` never logs them either.

## Objective

Make captured events durable. An event recorded in the content script should reach the webhook
(or a visible failure row in the popup), even if the service worker is asleep, restarts mid-flight,
or the browser is closed before the POST completes.

A secondary objective: when the content script's extension context is invalidated, surface that
clearly to the user so they know to reload the LinkedIn tab.

## Non-goals

- No `chrome.alarms` keep-alive ping. Fighting the MV3 lifecycle is brittle and risks extension
  store flags. The outbox pattern is the supported answer.
- No backend changes. The webhook contract is unchanged.
- No retry-with-backoff for HTTP failures from the webhook itself (4xx/5xx). Those already get a
  history row via spec 007; retrying a 400 won't help. The outbox only retries events that never
  reached the background worker.
- No UI for the outbox itself. It's invisible to the user when working; only a banner appears on
  context invalidation.
- No cross-device sync. `chrome.storage.local` is the right scope — events captured on one machine
  should not flush from another.

---

## Design

### Storage shape

New key under `chrome.storage.local`, plus `'pending'` joins the `Severity` union and `HistoryEntry`
gains a stable id used to update the row in place once delivery completes:

```ts
// types.ts
export type Severity = 'ok' | 'partial' | 'error' | 'pending';

export interface HistoryEntry {
  id: string;          // crypto.randomUUID(); stable across pending → ok/error transition
  ts: string;          // ISO; capture time when pending, delivery time once resolved
  status: Severity;
  event_type: EventType;
  name: string;
  page_url: string;
  message: string;
  warnings: string[];
  code?: string;
  http_status?: number;
}

export const STORAGE_KEYS = {
  // ...existing keys...
  OUTBOX: 'outbox', // OutboxEntry[]; FIFO, cap 50
} as const;

export interface OutboxEntry {
  history_id: string;   // matches HistoryEntry.id — used to update the pending row in place
  event: PipelineEvent; // exact payload the content script wanted to send
  enqueued_at: string;  // ISO timestamp, for staleness checks and "queued at" display
  attempts: number;     // incremented on each drain attempt
}

export const OUTBOX_CAP = 50;
export const OUTBOX_MAX_ATTEMPTS = 3;
export const OUTBOX_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export const BADGE_COLOR_PENDING = '#9333ea'; // purple
```

Pending rows are visible in the popup the instant they're captured. When the background delivers
the event, it finds the existing row by `HistoryEntry.id === OutboxEntry.history_id` and mutates
it in place (status, message, warnings, code, http_status, ts → delivery time). This avoids
showing two rows for the same event.

The outbox lives in `chrome.storage.local`, which is scoped to the extension's origin. LinkedIn's
JS cannot read or write it; other extensions cannot read it; only the pipeline-tracker content
script and background worker share access.

### Content script — enqueue before send

`sendEvent` in `content.ts:352` becomes async and writes both an `OutboxEntry` **and** a pending
`HistoryEntry` to `chrome.storage.local` in a single `set()` call before calling `sendMessage`.
The pending row makes the capture immediately visible in the popup; the outbox entry is what the
background drains.

```ts
async function sendEvent(event: PipelineEvent): Promise<void> {
  const historyId = crypto.randomUUID();
  const now = new Date().toISOString();

  const outboxEntry: OutboxEntry = {
    history_id: historyId,
    event,
    enqueued_at: now,
    attempts: 0,
  };

  const pendingHistoryEntry: HistoryEntry = {
    id: historyId,
    ts: now,
    status: 'pending',
    event_type: event.event_type,
    name: event.name,
    page_url: event.page_url,
    message: 'Queued — waiting to send',
    warnings: [],
  };

  await enqueuePendingEvent(outboxEntry, pendingHistoryEntry);

  try {
    await chrome.runtime.sendMessage({ kind: 'drain_outbox' });
    console.log('[Pipeline Tracker] drain requested');
  } catch (err) {
    if (isContextInvalidated(err)) {
      showContextInvalidatedBanner();
    } else {
      console.warn('[Pipeline Tracker] drain request failed (will retry on next event):', err);
    }
  }
}
```

`enqueuePendingEvent` atomically: appends to `OUTBOX` (oldest dropped if cap hit), prepends to
`HISTORY` (capped at `HISTORY_CAP`), and does **not** touch `UNREAD_COUNT` or `HIGHEST_SEVERITY`
(pending events don't nag).

`isContextInvalidated(err)` checks for `err?.message?.includes('Extension context invalidated')`.
`showContextInvalidatedBanner()` is described under "Context invalidation UX" below.

The content script does **not** wait for the drain to complete — it returns immediately after the
sendMessage resolves or rejects. The background does the actual POST and writes the history row.

### Background — drain on every trigger

`background.ts` gains a `drainOutbox()` function that:

1. Reads `OUTBOX` and `HISTORY` from `chrome.storage.local`.
2. For each entry, oldest first:
   - Increments `attempts`.
   - If `attempts > OUTBOX_MAX_ATTEMPTS` **or** entry is older than `OUTBOX_STALE_AFTER_MS`:
     update the matching `HistoryEntry` (by `id === history_id`) to `status: 'error'` with the
     drop message; remove the outbox entry; bump `UNREAD_COUNT` + `HIGHEST_SEVERITY`.
   - Otherwise POST the event (factored out of the current `handleMessage` body). On a recorded
     outcome (any 2xx, or a 4xx/5xx that produces an error classification), find the pending
     history row by id and **mutate it in place** with the resolved status/message/warnings/code/
     http_status/ts; remove the outbox entry; update unread + severity per the existing rules.
     On network/timeout failure, leave the row pending and the outbox entry in place with the
     incremented `attempts` count.
3. Persists the (shrunken) outbox and updated history back to storage.

The badge follows `HIGHEST_SEVERITY`, which is now the max over `ok`/`partial`/`error` only —
pending events do not affect the badge. (Surfaced in the popup, not in the badge: the badge is
for "needs attention," and a still-pending event is not yet actionable.)

Drain triggers:

- `chrome.runtime.onMessage` with `{ kind: 'drain_outbox' }` (from content script).
- `chrome.runtime.onStartup` (browser launch — picks up events queued before previous shutdown).
- `chrome.runtime.onInstalled` (extension update — guards against losing events across rebuilds).
- Inside `restoreBadgeOnStartup` (which runs on worker spawn) — call `drainOutbox()` once after
  badge restore.

A single in-memory `isDraining` flag prevents concurrent drains from the same worker instance
(two `sendMessage` calls in quick succession both triggering a drain). The flag is per-worker, so
if the worker dies mid-drain, the next spawn just starts fresh.

### Message protocol change

Today `onMessage` receives a raw `PipelineEvent`. After this change it receives a discriminated
union:

```ts
type BgMessage =
  | { kind: 'drain_outbox' }
  | PipelineEvent; // legacy, kept for one release for safety
```

Phase 1 of this spec accepts both — if the message has a `kind` field, treat it as a control
message; otherwise treat it as a legacy event payload and enqueue it before draining. After one
release the legacy branch can be removed.

### Outbox cap and eviction

Cap is 50 entries (`OUTBOX_CAP`). When the cap is hit, the **oldest** entry is dropped and a
history row is written: `"Outbox full — dropped oldest event from {ts}"`. 50 is generous: at
~30 events/day of LinkedIn activity, 50 is over a day of buffering. The user is going to notice
the connectivity problem long before the cap matters.

Stale entries (`OUTBOX_STALE_AFTER_MS`, 7 days) are dropped on next drain with a history row.
Rationale: a 2-week-old buffered connection request is no longer useful to log.

### Context invalidation UX

When the content script detects `Extension context invalidated`, it injects a small banner into
the LinkedIn page using the same shadow-DOM pattern the existing card overlays use (see
`linkedin-tracker/src/profile-page-card.ts` for reference). The banner reads:

> Pipeline Tracker needs a tab reload to keep capturing events. Click here to reload.

Clicking the banner runs `location.reload()`. The banner is dismissable and rate-limited (shown
at most once per page load — track via a module-level flag in `content.ts`).

This is the **only** in-page UI this extension adds. It's acceptable because (a) the content
script is already toast — at that point detection-avoidance is moot — and (b) without the banner
the user has no way to recover without dev-tools knowledge.

### History rows from the outbox

The pending row is written by the content script at capture time. The background updates it in
place when delivery resolves. The `ts` field on the resolved row is the **delivery** time, not
the original capture time; the original capture time stays available on the outbox entry's
`enqueued_at` while pending and is dropped once delivered. (Open question below: should we
surface "queued at" / "delayed by Xm" in the popup once resolved?)

Permanent-drop history rows (max-attempts, stale, cap-evicted) use `status: 'error'` with these
messages:

| Trigger                          | Message                                                |
| -------------------------------- | ------------------------------------------------------ |
| `attempts > OUTBOX_MAX_ATTEMPTS` | `"Dropped after 3 retries — check connection"`         |
| Entry > 7d old                   | `"Dropped — event was queued more than 7 days ago"`    |
| Cap eviction                     | `"Outbox full — dropped oldest event from {time}"`     |

---

## Code touchpoints

| File                                                      | Change                                                                                                                                       |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `pipeline-tracker/src/types.ts`                           | Add `OUTBOX` to `STORAGE_KEYS`; add `OutboxEntry`; add `id` to `HistoryEntry`; add `'pending'` to `Severity`; add `OUTBOX_CAP`, `OUTBOX_MAX_ATTEMPTS`, `OUTBOX_STALE_AFTER_MS`, `BADGE_COLOR_PENDING` |
| `pipeline-tracker/src/content.ts`                         | Convert `sendEvent` to async; add `enqueuePendingEvent`, `isContextInvalidated`, `showContextInvalidatedBanner`; remove the synchronous try/catch |
| `pipeline-tracker/src/background.ts`                      | Add `drainOutbox()`; wire to `onMessage`, `onStartup`, `onInstalled`; call from `restoreBadgeOnStartup`; update pending history rows in place; accept discriminated-union messages |
| `pipeline-tracker/src/popup/popup.html`                   | Add `.history-icon.pending` CSS rule (purple `#9333ea`)                                                                                      |
| `pipeline-tracker/src/popup/popup.ts`                     | Render `'⏱'` for pending status; "Queued — waiting to send" message                                                                          |
| `pipeline-tracker/src/manifest.json`                      | No change — `storage` permission already granted                                                                                             |
| `tests/unit/pipeline-tracker/content.test.ts`             | Test enqueue-before-send writes both outbox + pending history, context-invalidated detection, banner injection                               |
| `tests/unit/pipeline-tracker/background.test.ts`          | Test drain ordering (FIFO), pending → resolved row mutation, attempt-cap eviction, staleness eviction, concurrent-drain guard                |
| `tests/unit/pipeline-tracker/popup.test.ts`               | Render pending entries with purple icon                                                                                                      |
| `tests/__mocks__/chrome.ts`                               | Make storage stateful so enqueue/drain interactions can be asserted end-to-end                                                               |

No changes to popup, cards, build script, or webhook backend.

## Acceptance criteria

1. **Worker-asleep path.** Manually kill the service worker via `chrome://extensions` → inspect →
   stop. Fire a connection request on LinkedIn. Opening the popup immediately shows a purple ⏱
   "Queued — waiting to send" row. Within a few seconds the same row updates to a green ✓ "Logged"
   and the event lands in the sheet. (Verify by watching `chrome.storage.local.outbox` shrink to
   empty and the history row stay in place — no duplicate.)
2. **Browser-restart path.** With the webhook unreachable (e.g., wrong URL injected at build),
   fire 3 connection requests. Restart the browser. Restore the correct webhook (rebuild + reload
   extension). The 3 events drain and appear in the sheet on next worker spawn.
3. **Max-attempts eviction.** Point the webhook at an always-500 endpoint. Fire one event. After
   3 drain attempts (triggered by 3 subsequent events on the same tab), the original event is
   dropped with a "Dropped after 3 retries" history row.
4. **Stale eviction.** Manually plant an outbox entry with `enqueued_at` 8 days in the past via
   devtools. Trigger a drain. Entry is removed with a "Dropped — event was queued more than 7
   days ago" history row.
5. **Cap eviction.** Plant 51 entries. The oldest is dropped with a history row; the outbox
   contains exactly 50.
6. **Context invalidation banner.** Reload the extension from `chrome://extensions` while a
   LinkedIn tab is open. Fire a connection request. Banner appears in the tab. Clicking it
   reloads the tab. After reload, events fire normally.
7. **No host-DOM regression.** With the banner not shown (worker healthy, no context
   invalidation), `document.documentElement.outerHTML` is byte-identical to pre-change.
8. **No duplicate sends.** A single captured event produces exactly one row in the sheet, even if
   the drain is triggered multiple times (by `onStartup` + a fresh `sendMessage` racing).
   Enforced by removing entries from the outbox **before** the `handleMessage` POST returns
   success — the OutboxEntry `id` is the dedupe key.
9. **Existing tests pass.** All current unit tests in `tests/unit/pipeline-tracker/` continue to
   pass without modification (the discriminated-union message handler must remain
   backwards-compatible during the rollout window).

## Rollout

Single PR, single release. No feature flag — the outbox is always on. Users with no queued events
see no behavioral change. Users currently dropping events on the floor start succeeding silently.

Build version bumps to `1.1.0` (minor — additive reliability fix, no behavioral change to the
happy path).

## Open questions

- **Should the popup surface "delivered Xm late" once resolved?** The pending → resolved
  transition already tells the user something was delayed (they'd see the row sit pending). Once
  it flips to ok, the delay information is lost. Default: no — keep the popup minimal. The
  pending row itself is the delay signal. Revisit if dogfooding reveals confusion.
- **Should max-attempts be retry-with-backoff instead of fixed-3?** Three attempts triggered by
  later user actions is effectively "next 3 events." For low-volume users a one-off failure could
  sit in the outbox for hours before retry. Could add a `chrome.alarms`-based periodic drain
  every 5 minutes. Default: no alarm — the cost of an alarm permission and the keep-alive
  side-effect outweighs the rare case where a user makes one LinkedIn action then walks away.
- **Should the banner be styled to match the card overlays?** The existing cards use a specific
  teal palette. Banner could match for consistency. Default: yes, use the same shadow-DOM CSS
  module as `profile-page-card.ts`.
- **Should we add a "Retry now" button in the popup?** Trivial to add — calls `drainOutbox()`.
  Default: no for v1; outbox should be invisible. Add if users complain about waiting for the
  next event to trigger a drain.
