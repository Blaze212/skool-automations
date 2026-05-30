# @cs/scraping-core

Shared LinkedIn DOM extraction primitives used by every pipeline-tracker build.

## Contract

- **No `chrome.*` imports.** The package builds in Node and the browser
  identically. `globalThis.chrome` is never read here.
- **DOM access via the `document` handle.** `extract({document, target, …})`
  takes a `Document` rather than reading `globalThis.document`, so the
  package works inside iframes, the side-panel build (spec 012), and the
  jsdom test environment.
- **Pure validation.** `validate(event)` has no side effects and no DOM
  access; callers can safely run it from a service worker or background
  thread.

## Consumers

- **pipeline-tracker** (this repo) — internal Chrome extension. See
  `pipeline-tracker/src/content.ts` and `pipeline-tracker/src/types.ts`.
- **Publishable build** — spec
  [012](../../docs/specs/012-pipeline-tracker-publishable.md). Reuses
  cards + extract; ships its own UI shell.
- **On-device AI fallback** — spec
  [013](../../docs/specs/013-pipeline-tracker-ai-fallback.md). Extends
  `extract()` via the existing `aiOptions` parameter; broadens
  `ExtractionSource` to include `'ai-recovered'`.

## Public API

```ts
// Cards (DOM-scoped extraction objects)
import {
  Card, // namespace handle; future home of Card.from(target) router
  AcceptInvitationCard,
  ChatOverlayCard,
  MessengerPageCard,
  ProfilePageAcceptCard,
} from '@cs/scraping-core';

// Orchestrator — single entry per click target
import { extract, type ExtractResult } from '@cs/scraping-core';

// Validator — post-extraction noise + required-field checks
import { validate, type ValidationGap } from '@cs/scraping-core';

// Canonical shared types
import type { PipelineEvent, EventType, ExtractionSource } from '@cs/scraping-core';
```

## CI guard

`pnpm guard:no-cards-in-pipeline-tracker` checks that no `class …Card`
declaration exists under `pipeline-tracker/src/`. The CI workflow runs this
after typecheck/lint/test so a regression of the workspace split is caught
on PR.
