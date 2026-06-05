# Spec 090 — Tracker Unification

**Status:** Draft (MVP-first)
**Author:** Brainstorm session 2026-06-02
**Target:** MVP beta — handful of users, this week (sideloaded extension, full pipeline/state-machine)

---

## Summary

Unify three separate LinkedIn tracking systems (linkedin-tracker, pipeline-tracker internal, pipeline-tracker external) into a single Chrome extension, single edge function, and single config table. Replace API-key auth with JWT + binding token.

This spec is structured **MVP-first**: Part A is the week-one beta slice; Part B is the fast-follow that completes the unification. Part A is designed so Part B is a pure additive migration with **zero data loss**.

---

## Background

### Current state — three parallel systems

| System | Extension | Auth | Edge function | Output |
|--------|-----------|------|---------------|--------|
| LinkedIn tracker | `linkedin-tracker` | API key | `linkedin-tracker-webhook` | Google Sheet (simple append) |
| Pipeline tracker (internal) | `pipeline-tracker` (internal build) | API key | `pipeline-tracker-webhook` | Google Sheet + Branch taken state machine |
| Pipeline tracker (external) | `pipeline-tracker` (external build) | JWT + binding token | `tracker-import` | `tracker_events` DB table |

Three separate config tables: `linkedin_tracker_clients`, `pipeline_tracker_clients`, `fractional_clients`. No `user_id` on the pipeline table. Internal vs. external behavior controlled by a compile-time `BUILD_TARGET` flag.

### Problems

- Three codebases diverging, three auth models
- Internal build requires a separate `.crx` — not Chrome Web Store publishable
- No contact-level dedup — same person under 2 LinkedIn URLs creates duplicates
- Scraper failures are silent — garbage data enters with no visibility or recovery

---

## Goals

1. One Chrome extension (external build as base), eventually one Chrome Web Store listing
2. One edge function (`tracker-import`) handles all users
3. One config table (`tracker_clients`) drives dispatch — sheet layout is an enum, not a code branch
4. Two server-side state machines behind one `sheet_layout` enum — `pipeline` (internal, phrase-driven Branch taken) and `jobsearch` (external, event-type Connect→Accepted→DM) — sharing one generic resolver. No special extension build per user.
5. JWT + binding token auth everywhere — API keys retired
6. Contact dedup that survives users having 2+ LinkedIn URLs

---

# PART A — MVP (this week)

The beta is a **handful of fresh-provisioned users including the 2 internal pipeline users**, running a **sideloaded** extension. This removes two whole risk areas from the critical path:

- **No Chrome Web Store cutover** — beta users load unpacked / shared `.crx`
- **No API-key backfill / old-webhook deprecation** — beta users are provisioned fresh; old systems keep running untouched in parallel

### A1. Config table — `tracker_clients`

```sql
create table tracker_clients (
  user_id      uuid primary key references auth.users(id),
  sheet_id     text not null,
  sheet_layout text not null,  -- 'pipeline' (internal) | 'jobsearch' (external)
  created_at   timestamptz default now()
);
-- 'simple' (append-only Outreach Log) is a possible future layout, NOT built in Part A.
-- community_id dropped from Part A (eng-review Issue 4): nothing consumes it.
-- Re-add either when a consumer exists.

alter table tracker_clients enable row level security;

create policy "users_read_own_tracker_config"
  on tracker_clients for select using (auth.uid() = user_id);
-- inserts: service role only (manual provisioning for beta)
```

Beta provisioning: insert one row per beta user manually (user_id from auth.users by email; sheet_id from their Google Sheet; `sheet_layout = 'pipeline'` for the 2 internal users).

### A2. Contact identity — sheet stays the state store (eng-review Issue 1: Hybrid)

**Part A keeps the Google Sheet as the pipeline state store.** The existing `upsert()` already
resolves identity by **normalized LinkedIn URL first, then name fallback** — which *already
handles the 2-URL problem* (a new URL misses on URL, matches on name → same row). We reuse
that tested matching as-is. No `tracker_events`-replay, no bootstrap-read, no `contactKey`
grouping, no new index in Part A.

What we **do** extract now (the "hybrid"): a **generic monotonic stage resolver** plus the two
layout classifiers, into `_shared/stage-machine.ts` — dependency-free (no `esm.sh`),
unit-tested. Part B later swaps the I/O shell from sheet → `tracker_events` without touching
this core.

```ts
// _shared/stage-machine.ts — ONE resolver, two layouts (DRY)
// candidate = the stage this event argues for; null = no signal.
// Advances only to a strictly higher rank; unknown current rank = locked (never overwrite).
export function nextStage(
  current: string, candidate: string | null,
  rank: Record<string, number>, isInsert: boolean, defaultStage?: string,
): string | null

// INTERNAL 'pipeline'  — candidate from message-phrase classify(); default 'Awaiting reply'
//   rank { 'Awaiting reply':1, 'Want link?':2, 'Link sent (free week 1)':3 }  (Skool/$200k phrases)
// EXTERNAL 'jobsearch' — candidate from event_type; no default (every event maps)
//   rank { 'Connect':1, 'Accepted':2, 'DM':3 }
//   connection_request→Connect | accepted_connection→Accepted | direct_message→DM
//   (room for future 'DM-<type>' sub-stages via message parsing — out of scope now)
```

**Forward-compatibility guarantee (load-bearing for Part B):** every `tracker_event` MUST keep
raw `name` and `linkedin_url` (already in schema). Because `tracker_events` is append-only and
retains raw fields, Part B's `tracker_contacts` is a pure backfill → **zero data loss**.

### A3. Edge function — `tracker-import` (extended, not replaced)

```
existing:
  1. withAuth → userId
  2. validate rows
  3. upsert → tracker_events (dedup by user_id + history_id)

new for MVP:
  4. lookup tracker_clients for user_id (admin client; RLS doesn't block service role)
  5. dispatch by sheet_layout (response { imported, skipped, sheet_status? }):
       no row       → done (DB-only)
       'pipeline'   → runSheet(events, INTERNAL_LAYOUT)   ← 2 internal users
       'jobsearch'  → runSheet(events, JOBSEARCH_LAYOUT)  ← external beta users
  ('simple' append layout deferred — not needed for the beta; see A3.5)
```

**`runSheet(events, layout)`** — ONE read-once / write-once shell (eng-review Issue 2) that
serves both layouts via a `layout` config (column map + stage rank + classifier + flags):
1. **Sort** new events by `captured_at`, falling back to outbox send order for missing/equal
   timestamps (eng-review Issue 6) — stage progression is order-dependent.
2. **AI enrichment** (eng-review Issue 3): low-confidence rows with `recovered_html` run through
   the relocated spec-082 reconciliation with **bounded concurrency** (cap ~5, per-batch
   ceiling); AI failure → scraper-value fallback, no row dropped. High-confidence rows skip AI.
3. **Read the sheet once** (`People!A:Z`); build `normalizedUrl→rowIdx` and
   `normalizedName→rowIdx` lookup maps (O(rows)) so each event is an O(1) match
   (perf directive — don't inherit the per-event linear scan).
4. **Apply all events to an in-memory row model**, accumulating mutations (event 2 sees event
   1's row) via the generic `nextStage` + the layout's classifier. Per-event try/catch — one
   bad row never aborts the batch.
5. **Write once** via `batchUpdate`; then best-effort Logs-tab append if `layout.logsTab`.

**Error handling:**
- Sheet write fails after the `tracker_events` commit → log warning, return
  `sheet_status: 'partial'` (DB is the durable record). Never silently 200.
- **Self-healing:** a `partial` is safe to re-sync — `tracker_events` dedups on `history_id`
  and the sheet upsert is idempotent (URL/name match). No manual recovery.

### A3.5 Sheet layouts (column maps)

Both layouts share the read-once shell and upsert-by-identity (URL-primary, name-fallback).
They differ only in their **column map**, **stage signal**, and whether they keep a **Logs** tab.

**`pipeline` (internal)** — existing People sheet, unchanged from today's webhook:
- auto: Name, Title, LinkedIn URL (backfill-if-blank), Date connected / Date first DM sent
  (date-only, set-once), Last touch (datetime, every event), **Branch taken** (phrase-driven
  monotonic stage), Logs tab appended every event.
- stage signal: `classify(message_text)` (Skool link / $200k phrase). Manual stages locked.

**`jobsearch` (external)** — new layout:
| Column | Source / rule |
|--------|---------------|
| Person's Name | auto, backfill if blank |
| Person's Title | auto, backfill if blank |
| **Message Type** | auto — **monotonic stage** (Connect→Accepted→DM), `nextStage` by event_type rank |
| Date | auto — last-update timestamp `MM/DD/YYYY`, overwritten every event |
| Last Message | auto — latest `message_text` |
| LinkedIn URL | auto, identity, backfill if blank |
| LinkedIn Page URL | auto, backfill if blank |
| Company, Role Title, Status, Notes | **manual — never auto-written** |
- stage signal: event_type → {Connect, Accepted, DM}. No Logs tab for MVP (`logsTab: false`).
- **ASSUMPTION (confirm):** the monotonic rule applies to **Message Type**, not the manual
  `Status` column. Future `DM-<type>` sub-stages (via message parsing) are out of scope.

### A4. Index — none needed in Part A

The sheet is the state store, so there is **no `tracker_events` query by name/contact** in
Part A. The existing `(user_id, history_id)` unique index covers the dedup `IN` query. The
`idx_tracker_events_contact` index is deferred to **Part B** (where it becomes
`(user_id, contact_id, captured_at)`).

### A5. Extension — minimal changes

Base: external build of `pipeline-tracker`.

1. **Remove `BUILD_TARGET` split** — internal behavior is now server-side via `tracker_clients.sheet_layout`.
2. **Scrape confidence scoring** — runs in content script, cheap, no AI:
   - Name: 2–60 chars, not in junk set (`Connect`, `Follow`, `Message`, `1st`, `2nd`, `3rd`, `You`), letters/hyphens/apostrophes only
   - URL: matches `/linkedin\.com\/in\/[^/?#]{3,}/`
   - `'high'` if both pass, else `'low'`
3. **Add `scrape_confidence` column** to `tracker_events` (cheap; gives visibility into scraper degradation even before the review UI exists).
4. Outbox entry gains `scrape_confidence` and `needs_review` fields (the side-panel review UI is **Part B** — for MVP, low-confidence items still sync; they're just flagged in the data).

### A6. MVP rollout

```
1. Migration: create tracker_clients + RLS
              add scrape_confidence column to tracker_events
              (NO idx_tracker_events_contact — deferred to Part B)
2. Provision: insert tracker_clients rows for beta users (manual SQL)
3. Deploy:    extended tracker-import (dispatch + runPipeline read-once shell + 082 port)
4. Distribute: sideload unified extension to beta users (unpacked / .crx)
5. Verify:    internal users' sheets update correctly; simple users land in DB+sheet

Old systems (linkedin-tracker-webhook, pipeline-tracker-webhook, old extensions)
remain fully operational in parallel. Nothing is deprecated in the MVP.
```

**Rollback:** delete the beta users' `tracker_clients` rows; they fall back to DB-only or revert to old extension. Non-destructive throughout.

### A7. Test plan (eng-review)

Reuse the existing webhook suite as the **parity oracle** — it already covers insert/update,
Branch taken, URL-primary + name-fallback dedup, column resilience, Logs, and spec-082
reconciliation (`tests/unit/pipeline-tracker-webhook/*.test.ts`).

| New codepath | Test | Source |
|---|---|---|
| Generic `nextStage` + lock/rank semantics | unit | new (`_shared/stage-machine.ts`) |
| Internal phrase classifier (Skool/$200k) | unit | **move** from webhook test |
| Jobsearch event_type classifier (Connect/Accepted/DM monotonic) | unit | new |
| Dispatch (none / pipeline / jobsearch) | unit/integ | new |
| Read-once shell — **both layouts** (1 read, accumulating mutations, 1 `batchUpdate`) | integ (mock Sheets) | adapt webhook upsert tests + new jobsearch fixtures |
| Jobsearch column map (Date overwrite, Last Message, manual cols untouched) | integ | new |
| Batch ordering (sort by `captured_at`, missing/equal → send-order) | unit | new (edge case) |
| AI enrichment (bounded concurrency, `recovered_html`, AI-fail → scraper) | integ (mock AI) | adapt extract-fields + spec-082 |
| Partial status (sheet fails after DB commit → not 500) | integ | new |
| Idempotency / self-heal (re-import → dedup + no dup sheet row) | integ | new |
| `scoreCapture()` confidence (junk/valid/edge lengths/URL regex) | unit (extension, vitest) | new |
| `tracker_clients` RLS (user can't read another's row) | integ | new |

Register new unit suites in `vitest.unit.config.ts` + add `test:*:unit` scripts (per repo
conventions). **No eval rerun** for the relocated AI prompt — text unchanged; mocked tests
suffice (see TODOS for the post-deploy input-shape spot-check).

### Inline ASCII diagrams to embed in code

- `_shared/branch-taken.ts` — the `AUTO_RANK` monotonic ladder + manual-stage lock decision tree
- `tracker-import` pipeline path — the read-once → in-memory apply → write-once pipeline
- `tracker-import` dispatch — the `sheet_layout` decision branch

### Eng-review decision log

| # | Decision |
|---|---|
| 1 | **Hybrid**: extract pure core now; sheet stays Part A state store (no replay/bootstrap/contactKey) |
| 2 | Pipeline path = **read-once / write-once** shell with accumulating in-memory model |
| 3 | AI enrichment = **bounded concurrency** on `recovered_html`; AI-fail → scraper fallback |
| 4 | **Drop `community_id`** from `tracker_clients` (unused) |
| 5 | **Freeze** old `pipeline-tracker-webhook`; accept short-lived duplicate core (deleted in B3) |
| 6 | Batch ordering = **sort by `captured_at`**, fallback to send order |
| 7 | **No eval rerun** for relocated AI prompt; adapt mocked tests + post-deploy spot-check |
| 8 | **Second state machine** for external users: `jobsearch` layout (event-type monotonic Connect→Accepted→DM). Both layouts share ONE generic `nextStage` + read-once shell (DRY); enum = `pipeline`\|`jobsearch`; `simple` append deferred. |

### A8. Commit plan (each < 500 lines, sequenced by dependency)

Two repos. Edge-function commits (careersystems) and extension commits (skool-automations)
are independent workstreams that meet at the import contract. Each commit ships with its tests
and is independently reviewable.

**Repo A — careersystems/workspace (edge function)**

```
C1  Migration + types                                              ~80 LOC
    • migration: tracker_clients + RLS; add scrape_confidence to tracker_events
    • regenerated DB types
    • (config.toml unchanged — tracker-import already registered)
    deps: none

C2  Extract generic stage core + classifiers                       ~400 LOC
    • _shared/stage-machine.ts  (generic nextStage + rank/lock semantics)
    • _shared/stage-machine.layouts.ts  (INTERNAL phrase classify + JOBSEARCH event_type map)
      — internal logic COPIED out; old webhook left frozen (Decision 5)
    • tests/unit/_shared/stage-machine.test.ts  (generic + both classifiers)
    • vitest.unit.config.ts include + package.json test:stage-machine:unit
    deps: none (parallel with C1)

C3  Dispatch + layout configs                                      ~350 LOC
    • tracker-import: tracker_clients lookup, sheet_layout switch (pipeline|jobsearch),
      additive response contract { imported, skipped, sheet_status }
    • INTERNAL_LAYOUT + JOBSEARCH_LAYOUT column-map configs
    • getTrackerClient db helper
    • tests: dispatch (none/pipeline/jobsearch), tracker_clients RLS
    • ADR: server-side layout dispatch + two state machines
    deps: C1

C4  Read-once / write-once shell (layout-driven)                   ~450 LOC
    • tracker-import/run-sheet.ts: 1 read → url/name lookup maps → in-memory row model
      (accumulating, applies layout column-map + nextStage) → 1 batchUpdate → optional Logs;
      sort by captured_at + send-order fallback; per-row try/catch; partial; inline ASCII diagram
    • tests: read-once, ordering, accumulating mutations, partial, idempotency
      — run against BOTH layouts (pipeline + jobsearch) using the parity-oracle fixtures
    deps: C2, C3
    ⚠ if the diff exceeds 500, split: C4a shell impl / C4b shell tests

C5  AI enrichment (relocated spec-082)                             ~350 LOC
    • relocate extract-fields + maybeEnrichWithAi into tracker-import (read recovered_html),
      bounded-concurrency pool (cap ~5 + per-batch ceiling), AI-fail → scraper fallback
    • tests (mock AI): enrichment, concurrency cap, fallback, high-conf skips AI
    deps: C4
```

**Repo B — skool-automations (extension)**

```
C6  scoreCapture + outbox fields                                   ~300 LOC
    • content-script scoreCapture() (name/url heuristic → 'high'|'low')
    • outbox entry gains scrape_confidence, needs_review; send scrape_confidence on events
    • tests: scoreCapture (junk/valid/edge lengths/URL regex)
    deps: none (parallel with all edge-fn commits)

C7  Remove BUILD_TARGET split                                      ~varies
    • collapse destination-impl to the single external strategy; drop internal build branch
      in background.ts; build.ts + manifest split cleanup
    • tests: update to the single target
    deps: C6
    ⚠ likely > 500 — split: C7a consolidate destination strategy / C7b background.ts +
      build/manifest cleanup
```

**Non-code (runbook, not a LOC commit)**

```
C8  Provisioning runbook: SQL to insert tracker_clients rows for the beta users
    (user_id by email, sheet_id, sheet_layout). deps: C1 deployed.
```

**Merge order:** C1 → C2/C3 → C4 → C5 (edge fn), C6 → C7 (extension) in parallel; C8 last.
Old systems stay live throughout (parallel run), so partial completion is always safe to ship.

# PART B — Fast-follow (completes unification)

Built on the MVP, each item independently shippable.

### B1. `tracker_contacts` table + backfill

```sql
create table tracker_contacts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id),
  name          text not null,       -- normalized via contactKey()
  title         text,
  vanity_url    text,                -- linkedin.com/in/john-smith (alpha+hyphen slug)
  generated_url text,                -- .../john-smith-a1b2c3 or ACoA...
  all_urls      text[] not null default '{}',
  needs_review  boolean not null default false,  -- same-name-different-person hook
  created_at    timestamptz default now(),
  unique(user_id, name)
);
create index on tracker_contacts using gin(all_urls);
create index on tracker_contacts(user_id, name);
```

Backfill from the append-only `tracker_events` log (zero data loss):
1. Per user, group events by `contactKey(name)`, create one contact per group
2. Accumulate `all_urls`; classify each slug vanity vs generated
3. Add `contact_id` FK to `tracker_events`, populate via resolution
4. Switch `runPipeline` from name-grouping → `contact_id` grouping
5. Replace `idx_tracker_events_contact` with `(user_id, contact_id, captured_at)`

URL classification: slug matching `/^[a-zA-Z][a-zA-Z\-]+[a-zA-Z]$/` → vanity, else generated.
Resolution order: URL match (GIN) wins → name match (set `needs_review` on title mismatch) → new contact.

### B2. Side-panel review UI

- Pending-items list with ⚠ on low-confidence rows
- Inline edit (name, title, linkedin_url); on save → `user_reviewed = true`, skip `recovered_html` (no server AI needed)
- Auto-drain skips `needs_review && !user_reviewed`; "Sync this one" / "Sync all incl. ⚠" actions
- Badge shows warning state when `needs_review` items pending

### B3. Chrome Web Store + legacy decommission

- Publish unified extension; external users migrate via install + binding
- Old API keys stay valid until old-webhook call volume → 0 (monitor)
- Drop `linkedin-tracker-webhook`, `pipeline-tracker-webhook`, old config tables once quiet

### B4. Manual contact resolution (future)

UI over `needs_review` rows to merge/split same-name-different-person contacts.

---

## Non-goals

- **Portal / CRM UI.** The Google Sheet is the intended interface for the beta and the
  foreseeable future — there is no portal view planned. `tracker_events` (and Part B's
  `tracker_contacts`) keep all the data a future UI would need, so a portal can be built
  later as a pure read-layer with no changes to the capture side. Parked indefinitely.
- Backend AI contact dedup (embedding-based)
- Browser-side AI field extraction (server-side quality is better, token cost low)
- `fractional_clients` consolidation (different domain)

---

## Open questions

1. **Bootstrap re-read** — MVP reads the Sheet for starting stage on a contact's first sync. Until that contact appears in `tracker_events`, we re-read each sync. Acceptable for beta volume; revisit if it gets chatty.
2. **`tracker_clients` provisioning** — manual SQL for beta. Admin UI is post-beta.
3. **Old `linkedin-tracker` API-key users** — out of scope for MVP; addressed in B3.
