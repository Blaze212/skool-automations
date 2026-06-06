# `linkedin_url` → `profile_url` rename (complete)

## Why

Capture is site-agnostic (spec 016) and no longer LinkedIn-specific. The contact
field was renamed `linkedin_url` → `profile_url` throughout the extension,
`@cs/scraping-core`, **and the wire/DB contract**, in lockstep with the
CareerSystems backend.

## Status: DONE

- **Extension + `@cs/scraping-core`**: every internal type, the AI prompt/schema,
  the heuristic, the editable-field `data-field`, the UI labels, and the CSV
  export column header use `profile_url`.
- **Wire contract**: `PipelineEvent.profile_url` (was `linkedin_url`) — emitted by
  `enqueueManualCapture` / `reviewOutboxEntry`, validated by `validate.ts`, pinned
  by `tests/fixtures/pipeline-tracker/manual-capture-wire-oracle.json`.
- **Backend (separate CareerSystems repo)**: the `tracker-import` and the
  `tracker_events.profile_url` column were updated to match (confirmed before this
  rename shipped).

No `linkedin_url` identifiers remain anywhere in this repo. The only surviving
LinkedIn reference is the functional `linkedin.com` host check in
`capture-heuristic.ts` `cleanUrl()` (strips `?lipi`/`?trk` tracking params) —
intentional, since removing it would degrade URL canonicalization.
