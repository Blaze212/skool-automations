---
name: spec-writer
description: Write, organize, and maintain feature specs for the CareerSystems project. Use this skill whenever the user asks to create a spec, document a feature plan, write a deprecation spec, or capture implementation requirements. Also use when renaming, numbering, or moving spec files — including when a spec has been implemented and should be archived.
---

# Spec Writer

Guidelines for creating, naming, and lifecycle-managing specs in `docs/specs/`.

The spec-reviewer agent (`.claude/agents/spec-reviewer.md`) is the downstream
consumer of every spec you write. Write specs so they pass that review cleanly:
explicit contracts, clear phase boundaries, no ambiguous ownership.

---

## File Naming Convention

Every spec file gets a zero-padded three-digit numeric prefix, a dash, and a
short kebab-case description:

```
NNN-short-description.md
```

**Examples:**
```
001-skool-chat-bot.md
002-job-search-deprecation.md
003-resume-versioning-extraction.md
```

### Picking the next number

Before creating a file, list the directory to find the current highest prefix:

```bash
ls docs/specs/ | grep -E '^[0-9]' | sort | tail -1
```

Increment by 1. If no numbered files exist yet, start at `001`.

Numbers are permanent identifiers — do NOT reuse a number even after a spec is
completed and archived.

### Renaming legacy unnumbered specs

Do not rename unnumbered files unprompted. Only renumber a file if the user
explicitly asks or you are already touching it for another reason.

---

## Spec Lifecycle

```
docs/specs/NNN-my-feature.md            ← in-flight or not yet started
docs/specs/completed/NNN-my-feature.md  ← fully implemented
```

### Moving a spec to completed

When a spec has been fully implemented (all acceptance criteria met, code
merged to main), move it:

```bash
mkdir -p docs/specs/completed
mv docs/specs/NNN-my-feature.md docs/specs/completed/NNN-my-feature.md
```

Add a status line at the top before moving:

```markdown
**Status:** Implemented — completed YYYY-MM-DD
```

---

## Spec Template

Not every spec needs every section. **Objective, Non-goals, and Acceptance
Criteria are always required.** Add or drop other sections to fit the feature.

The sections mirror what the spec-reviewer agent checks, so a complete spec
means fewer blocking questions during review.

```markdown
# <Feature Name>

**Status:** Draft | Ready for review | Ready for implementation
**Owner:** <team or person>
**Last updated:** YYYY-MM-DD

## Objective

One paragraph. What are we building and why?

## Non-goals

Bullet list of things explicitly out of scope.

## Business Rationale

Why now? What user or business problem does this solve?

## Architecture

Key decisions with rationale. Call out:
- Schema / migration changes
- New or changed Edge Functions (request/response contract)
- Frontend-vs-backend ownership
- Shared package impact (@cs/ui, @cs/diagnostic)
- Auth model (withAuth, isServiceRoleBearer, webhook secret, etc.)
- External dependencies or new env vars (Doppler-managed)

Note here if any decision warrants a new ADR in `docs/adr/`.

## Implementation Phases

Break into independently-deployable phases where possible. For each phase:

### Phase N — Name

- What changes
- DB migrations required
- Edge Function changes
- Frontend changes
- Tests required

## Edge Cases & Risk

Address: network failures, race conditions, empty/error/loading states,
client-vs-server validation boundaries, RLS gaps, embed isolation.

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| ... | H/M/L | H/M/L | ... |

## Acceptance Criteria

Concrete and verifiable — not "it works" but "endpoint returns 200 with shape
X", "CI passes", "table Y is absent from production".

- [ ] Migrations applied and tested locally
- [ ] RLS policies verified
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format` pass
- [ ] Tests written and passing (unit / integ / e2e as appropriate)
- [ ] ADR filed in `docs/adr/` (if architecture decision was made)
- [ ] No hardcoded secrets
- [ ] <spec-specific items>
```

---

## After Writing the Spec

Once the spec is saved, suggest running the spec-reviewer agent:

> "Want me to run the spec-reviewer agent on this? It will check for architectural
> gaps, missing contracts, and security issues before implementation starts."

The spec-reviewer lives at `.claude/agents/spec-reviewer.md` and is invoked via
the Agent tool with `subagent_type: spec-reviewer`.

---

## Checklist Before Saving

- [ ] File is named `NNN-description.md` with the next available number
- [ ] Objective is one focused paragraph
- [ ] Non-goals section is present
- [ ] Architecture section covers schema, API contracts, auth model, and shared package impact
- [ ] Each phase is independently deployable where possible
- [ ] Acceptance criteria are concrete and checkable
- [ ] If updating an in-progress spec, the existing file is edited (not duplicated)
