# Pipeline Tracker — Scraping Core Extraction

**Status:** Draft
**Owner:** Barton Holdridge
**Last updated:** 2026-05-29

**Related (must be read first):**

- [006-pipeline-tracker.md](006-pipeline-tracker.md) — current internal extension; defines the
  card classes, `PipelineEvent`, content-script extraction pipeline
- [009-pipeline-tracker-outbox-queue.md](009-pipeline-tracker-outbox-queue.md) — durable outbox;
  `OutboxEntry`, `HistoryEntry.id`, message protocol

**Downstream specs that depend on this one:**

- [012-pipeline-tracker-publishable.md](012-pipeline-tracker-publishable.md) — Web Store build
- [013-pipeline-tracker-ai-fallback.md](013-pipeline-tracker-ai-fallback.md) — on-device LLM
  field recovery

---

## Objective

Extract the LinkedIn DOM extraction logic — card classes, the `Card.from(target)` router, the
`validate()` noise/required-field checks, and the `extract()` orchestrator — out of
`pipeline-tracker/src/` into a shared workspace package `@cs/scraping-core` with **zero
`chrome.*` imports.**

This is a pure refactor with no user-visible behavior change. It exists because two downstream
specs (012 publishable build, 013 on-device AI fallback) both need to import the cards and
validator. Without this extraction we'd either duplicate the cards into each build or build
path-rewrite hacks into esbuild. A workspace package is the clean answer.

---

## Non-goals

- No behavior change to the internal extension build. Byte-identical wire payload, badge
  behavior, history rendering, outbox semantics.
- No new features. No bug fixes that aren't already on `main`.
- Not touching `linkedin-tracker/` — that sibling extension has its own card pattern and stays
  independent in this spec.
- No on-device AI fallback (deferred to 013).
- No publishable manifest, side panel, or sync protocol (deferred to 012).

---

## Why now

Spec 012 and spec 013 are both written. Both need to `import { extract, validate, Card } from
'@cs/scraping-core'`. Shipping either one without this refactor first means duplicating ~600
lines of card extraction logic, and any future fix to a LinkedIn DOM selector requires touching
two or three places. Worth the upfront work.

---

## Target repository layout

```
skool-automations/
├── pnpm-workspace.yaml                ← NEW
├── package.json                       ← workspaces field added
├── tsconfig.json                      ← project references
├── packages/
│   └── scraping-core/                 ← NEW workspace package
│       ├── package.json               ← name: "@cs/scraping-core"
│       ├── tsconfig.json
│       ├── README.md
│       ├── src/
│       │   ├── index.ts               ← public API surface
│       │   ├── types.ts               ← PipelineEvent, EventType, ExtractionSource
│       │   ├── validate.ts            ← noise + required-field checks
│       │   ├── extract.ts             ← orchestrator: route → selectors → validate → result
│       │   └── cards/
│       │       ├── index.ts           ← Card.from(target) router + exports
│       │       ├── accept-invitation-card.ts
│       │       ├── chat-overlay-card.ts
│       │       ├── messenger-page-card.ts
│       │       ├── profile-page-accept-card.ts
│       │       └── profile-page-card.ts
│       └── tests/
│           └── cards/                 ← existing card tests live here
└── pipeline-tracker/
    └── src/
        ├── types.ts                   ← thin shim re-exporting from @cs/scraping-core
        └── content.ts                 ← imports from @cs/scraping-core; shrinks to chrome wiring
```

`linkedin-tracker/` is not touched. Its card pattern is similar but not identical; convergence is
a future spec (see TODOS.md).

---

## Public API — `packages/scraping-core/src/index.ts`

```ts
// Cards
export { Card, type CardClass } from './cards';
export {
  AcceptInvitationCard,
  ChatOverlayCard,
  MessengerPageCard,
  ProfilePageAcceptCard,
  ProfilePageCard,
} from './cards';

// Orchestrator
export { extract, type ExtractResult, type ExtractInput } from './extract';

// Validator
export {
  validate,
  type ValidationResult,
  type ValidationGap,
} from './validate';

// Shared types (canonical home)
export type {
  PipelineEvent,
  EventType,
  ExtractionSource,
} from './types';
```

`ExtractResult` carries:

```ts
export interface ExtractResult {
  event: PipelineEvent;                    // fields filled to best ability
  source: 'selectors';                     // 'ai-recovered' added by spec 013
  validation: ValidationResult;            // { dirty, gaps }
}
```

Spec 013 will extend the orchestrator's `extract()` signature with an optional `aiOptions`
parameter and broaden `source` to include `'ai-recovered'`. This spec ships the
selectors-only base.

---

## Implementation phases

Each phase ships as ONE PR sized to ~200-400 lines of diff. The internal extension flow must
work after every phase — no half-states.

### Per-PR workflow (mandatory for every phase in this spec)

Before opening a PR for any phase:

1. `pnpm typecheck && pnpm test && pnpm lint && pnpm format:check` — must be green.
2. **Run `/code-review --effort high` against the current diff.** This invokes the multi-angle
   reviewer skill on the local branch (no PR required). Address every CONFIRMED finding.
   Triage PLAUSIBLE findings — fix or document why you're deferring; never silently drop.
3. Re-run step 1 after the fixes.
4. Only THEN open the PR.

Rationale: this protocol was added after the spec-011 implementation review found 4 real
issues (two diagnostic-correctness bugs introduced by Phase 4-5, two validator regex
over-matches) that would have shipped without it. Catching them on the local branch instead
of the PR review keeps the PR diff focused on intended changes.

### Phase 1 — Workspace skeleton (~200 lines)

**Goal:** turn the repo into a pnpm workspace with an empty `@cs/scraping-core` package nobody
imports yet.

- `pnpm-workspace.yaml` — `packages: ['packages/*']`. Source of truth for pnpm; do not also
  add a `workspaces` field to root `package.json` (avoid drift).
- `packages/scraping-core/package.json` — name `@cs/scraping-core`, `"type": "module"`, no
  runtime deps. Marked private (`"private": true`).
- `packages/scraping-core/tsconfig.json` — extends a shared `tsconfig.base.json`; **MUST set
  `compilerOptions.composite: true`** for project references. Also `rootDir: ./src`, explicit
  `outDir: ./dist`.
- `packages/scraping-core/src/index.ts` — empty `export {};`.
- `packages/scraping-core/README.md` — one paragraph: "Shared LinkedIn DOM extraction. No
  `chrome.*` imports. Consumed by pipeline-tracker."
- Root `tsconfig.json` — `"files": []` + a `references` array pointing at every workspace
  package (currently just scraping-core). Build with `tsc --build` (incremental) from here.
- `vitest.config.ts` — add `@cs/scraping-core` alias pointing at the package's
  `src/index.ts`.
- `pipeline-tracker/package.json` (if it exists; create if not) — declare
  `"dependencies": { "@cs/scraping-core": "workspace:*" }`. The `workspace:*` protocol
  forces local resolution and prevents accidental registry pulls.

**Verification:** `pnpm install` resolves the workspace; existing tests still pass against the
unchanged `pipeline-tracker/src/`.

**Done when:** the workspace is set up and `import "@cs/scraping-core"` resolves to an empty
module from `pipeline-tracker/src/content.ts` (try it in a throwaway commit).

---

### Phase 2 — Move card classes (~350 lines)

**Goal:** the cards live in scraping-core; pipeline-tracker imports them through the package.

- Move `pipeline-tracker/src/*-card.ts` → `packages/scraping-core/src/cards/`.
- Create `packages/scraping-core/src/cards/index.ts` exporting each card class + the
  `Card.from(target)` router (today this router logic lives inline in `content.ts`; just the
  type-discriminator and dispatch — full extraction stays where it is for Phase 2).
- Update `pipeline-tracker/src/content.ts` imports: change
  `import { ProfilePageCard } from './profile-page-card.ts'` →
  `import { ProfilePageCard } from '@cs/scraping-core'`.
- Move `tests/unit/pipeline-tracker/*-card.test.ts` → `packages/scraping-core/tests/cards/`.
  Update each test's import path. Assertions unchanged.
- Update `vitest.config.ts` test glob if needed to include the new path.

**Verification:** all card tests pass at new location; `pipeline-tracker/dist-internal/` builds
and the existing internal flow works end-to-end (manual smoke: one connection request →
expected sheet row + badge update).

**Done when:** zero `*-card.ts` files in `pipeline-tracker/src/`; CI guard #1 (below) would pass
if it existed.

---

### Phase 3 — Extract validator (~250 lines)

**Goal:** noise-pattern + required-field validation lives in one place.

- Create `packages/scraping-core/src/validate.ts`. Move the noise regexes (the "Premium" badge,
  the `1st`/`2nd` connection markers, mutual-connection counts) and the required-field gap
  detection currently inline in `content.ts` into this module.
- Export `validate(event): ValidationResult` where `ValidationResult = { dirty: boolean; gaps:
  ValidationGap[] }` and `ValidationGap` enumerates which fields tripped which rule.
- `content.ts` imports and calls `validate()` at the same point it currently runs its inline
  checks.
- Add unit tests for each known noise pattern + each required-field gap. ~10-15 cases.

**Verification:** existing behavior preserved; tests cover all branches.

**Done when:** `validate.ts` is sole owner of validation; no inline noise regexes remain in
`content.ts` or any card file.

---

### Phase 4 — Extract orchestrator (~350 lines)

**Goal:** the full `route → selectors → validate → ExtractResult` pipeline is one function.

- Create `packages/scraping-core/src/extract.ts`. Move the orchestration logic out of
  `content.ts`: `Card.from(target) → card.toEvent() → validate() → ExtractResult`.
- Export `extract({document, target, pageUrl}): ExtractResult`.
- `content.ts` shrinks to: MutationObserver setup, click handlers, dedup window, call
  `extract()`, persist via `chrome.storage` + sendMessage.
- Add `tests/extract.test.ts` with HTML-fixture inputs and expected ExtractResult outputs (one
  fixture per card type, plus a deliberately-dirty fixture exercising the `dirty: true` branch).

**Verification:** end-to-end card extraction parity with `origin/main` baseline — same
`PipelineEvent` shape on every captured fixture.

**Done when:** `extract.ts` owns the orchestration; `content.ts` is ~150 lines of pure
chrome-API wiring.

---

### Phase 5 — Types promotion + CI guard (~200 lines)

**Goal:** `@cs/scraping-core` owns the canonical types; CI prevents regressions.

- Move `PipelineEvent`, `EventType`, `ExtractionSource` from `pipeline-tracker/src/types.ts` to
  `packages/scraping-core/src/types.ts`.
- `pipeline-tracker/src/types.ts` re-exports from `@cs/scraping-core` for backward compatibility
  with `background.ts`, `popup/`, etc. — keeps spec-012's PR diff smaller too.
- Add CI guard: shell check in CI that `grep -rE 'class\s+\w+Card\b' pipeline-tracker/src/`
  returns zero matches.
- Update `packages/scraping-core/README.md` with the package contract:
  - "No `chrome.*` imports."
  - "DOM accessed via the `document` handle passed into `extract()`."
  - "Consumers: pipeline-tracker (012), AI fallback (013)."
- Tag this PR's merge as the green-light for spec 012 to start.

**Done when:** CI guard runs in PR pipeline; downstream specs can `import` freely; canonical
type ownership is unambiguous.

---

## Acceptance criteria

1. `pnpm install && pnpm typecheck && pnpm test && pnpm lint` green at the end of every phase.
2. The internal extension behavior is byte-identical pre/post refactor — verified at end of
   Phase 4 by a manual smoke test (one connection request → expected sheet row + badge update +
   history entry) and continuously by the existing card unit tests.
3. `tests/unit/pipeline-tracker/*-card.test.ts` migrate to
   `packages/scraping-core/tests/cards/` without source modification (assertions/expectations
   unchanged).
4. New `extract.ts` test suite covers each card type's happy path + at least one dirty path per
   validation gap.
5. CI guard prevents future `*Card` symbols from leaking back into `pipeline-tracker/src/`.

---

## Rollout

Five sequential PRs against the same feature branch. Each phase is independently reviewable and
revertable. After each phase, the internal extension MUST still build and ship — no half-states
allowed.

No feature flag. No staged release. This is a refactor; users see nothing.

---

## Open questions

- **Should `linkedin-tracker/`'s card pattern be ported in this spec too?** No. linkedin-tracker
  has its own slightly different `ConnectionSearchCard` / `ProfilePageCard` /
  `MessengerPageCard` lineage. Convergence is a P2 TODO (TODOS.md) tracked separately. This spec
  intentionally only moves pipeline-tracker's cards.
- **Should AI fallback live in this package or a sibling `@cs/scraping-ai`?** Spec 013 puts it
  in `packages/scraping-core/src/ai-fallback/`. Keeping it in scraping-core means the
  `extract()` orchestrator can call into it directly without crossing a package boundary.
  Revisit if a third extraction consumer needs scraping-core but not AI.
- **Workspace tool: pnpm or npm?** Repo currently uses pnpm. Stick with pnpm.

## Best-practice reference

Implementers should consult these memory references before each phase:

- pnpm workspaces + TypeScript project references — see memory note
  `pnpm-typescript-monorepo`. Key rules: `composite: true` on every referenced package; build
  with `tsc --build`; cross-package deps use `workspace:*` protocol; do NOT mix `paths`
  aliases with project references.
