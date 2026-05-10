# skool-automations

Internal automation tooling for Barton's fractional advisory practice.

## Migration naming

All migration files must follow this convention:

```
YYYYMMDD-NNN-skool-<description>.sql
```

- `YYYYMMDD` — date the migration was authored
- `NNN` — zero-padded sequence number within that date (001, 002, …)
- `skool` — project namespace (these migrations share a prod migration table with the client-facing CareerSystems project)
- `<description>` — concise kebab-case description of what the migration does

**Example:** `20260601-001-skool-fractional-onboarding.sql`

The existing `20260506000000_skool_knowledge.sql` predates this convention and should be renamed when it is safe to do so (i.e., before the migration has been applied to a shared production database).

## Edge Functions

### File naming

The main entrypoint for each function is named after its folder, not `index.ts`:

```
supabase/functions/<name>/<name>.ts
```

This makes the file findable by name in VS Code fuzzy search.

### Shared utilities

All functions import from `supabase/functions/_shared/` — never inline raw `Deno.env.get()` or `createClient()` calls:

- `env.ts` — `loadSupabaseEnv()`, `loadSupabaseServiceEnv()` — fail-fast env loaders
- `supabase-admin.ts` — `createAdminClient(schema?)` — service-role client factory; always call inside the handler, never at module scope
- `errors.ts` — full typed error class table; `logError`, `errorBody`, `normalizeError`
- `logger.ts` — pino logger; use `logger.child({ fn: '<name>' })` at the top of each handler and pass it down — never use root `logger` inside a handler

### Error classes

| Class | HTTP | Code |
|---|---|---|
| `ValidationException` | 400 | `VALIDATION_ERROR` |
| `AccessDeniedException` | 403 | `ACCESS_DENIED` |
| `UpgradeRequiredException` | 402 | `UPGRADE_REQUIRED` |
| `ThrottlingException` | 429 | `THROTTLED` |
| `ResourceNotFoundException` | 404 | `NOT_FOUND` |
| `ConflictException` | 409 | `CONFLICT` |
| `InternalServiceException` | 500 | `INTERNAL_ERROR` |
| `AiException` | 502 | `AI_ERROR` |
| `OpenAiException` | 502 | `OPENAI_ERROR` |
| `AnthropicException` | 502 | `ANTHROPIC_ERROR` |

All error responses use `errorBody(normalized)` — shape is `{ success: false, error: string, code: string }`. Never hand-craft error shapes.

### Function shape

Follow the `/edge-function-env-pattern` and `/new-edge-function` skills. Key rules:

1. Webhook functions validate `X-Webhook-Secret` header before any processing
2. Two-layer try/catch: outer for framework panics, inner for application errors
3. Throw typed error classes — never `new Error(...)`; pass `sourceError: err` when wrapping
4. All catch blocks call `logError(err as Error, ...)` at the handler boundary — sub-functions throw, they don't log
5. `verify_jwt = false` in `config.toml` for every function (ES256 JWTs; auth is handled in-function)
6. Create Supabase clients inside the handler, not at module scope

### Module isolation — Deno.serve side-effect rule

Every file containing `Deno.serve()` or `serve()` registers an HTTP handler as a module-level side effect. **Never import from a file that contains `serve()`**. If shared logic is needed, extract it into a separate file with no `serve()` call and import from there.

### `unknown` type ban

**Never use the `unknown` type.** Ask for explicit permission before using it. Use `Error` for caught errors (enabled by `useUnknownInCatchVariables: false` in `supabase/functions/deno.json`). Cast with `err as Error` at handler catch boundaries.

## Local development setup

This project shares the CareerSystems local Supabase stack — it does **not** run its own Docker containers.

**Prerequisite:** CareerSystems Supabase must be running.

```bash
# From the CareerSystems workspace (only needed once per machine boot)
cd /Users/barton/workspaces/careersystems/workspace && supabase start
```

**First-time migration** (applies skool schema to the CS local DB):

```bash
pnpm migrate:local
```

This pushes `supabase/migrations/` to `postgresql://postgres:postgres@127.0.0.1:54322/postgres`. Migration names carry the `skool-` prefix so they don't conflict with CS migrations in the shared tracking table.

**Serve functions locally:**

```bash
pnpm functions:serve
# Function available at http://localhost:8000
```

Uses `deno run` directly (not `supabase functions serve`, which requires its own local Docker stack). The `--env-file=.env.local` flag injects credentials so the function connects to the CS Supabase at `127.0.0.1:54321`. `WEBHOOK_SECRET` defaults to `local-test-secret`.

Each function listens on port 8000. When a second function is added, `functions:serve` will need to become a script that runs both on separate ports.

**Manual test curl:**

```bash
curl -X POST http://localhost:8000 \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: local-test-secret" \
  -d '{"data":{"Client full name":["Jane Doe"],"Email for Google Drive sharing":["jane@example.com"],"Email for Skool (leave blank if same as Drive email)":[""],"Program start date":["2026-06-01"],"Notes":[""]}}'
```

## Verification

After every change, run in this order:

1. `pnpm typecheck:functions` — Deno type-check all edge functions
2. `pnpm test` — run unit tests; fix failures before proceeding
3. `pnpm format:functions` — auto-format with deno fmt
4. `pnpm lint:functions` — fix lint errors

## Tests

All code changes must be accompanied by unit tests in `tests/unit/`. Edge function tests live in `tests/unit/functions/<name>.test.ts`.

The vitest config aliases Deno URL imports (`deno.land/std`, `esm.sh`, `npm:`) to mocks in `tests/__mocks__/`. When adding a new Deno-specific import to a function, add the corresponding mock alias to `vitest.config.ts`.
