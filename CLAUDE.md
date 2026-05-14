# skool-automations

Internal automation tooling for Barton's fractional advisory practice.

## Migration naming

All migration files must follow the Supabase CLI convention with an `internal_cs_` namespace prefix:

```
YYYYMMDDHHMMSS_internal_cs_<description>.sql
```

- `YYYYMMDDHHMMSS` — 14-digit timestamp (Supabase CLI requirement for local migration runner)
- `internal_cs_` — namespace prefix; these migrations share a prod migration tracking table with the CareerSystems project, so the prefix prevents name collisions
- `<description>` — concise snake_case description

**Example:** `20260512000001_internal_cs_rename_schema.sql`

## Edge Functions

### File naming

Each function uses a two-file layout:

```
supabase/functions/<name>/index.ts          ← thin entrypoint: just serve(handler)
supabase/functions/<name>/<name>.ts         ← all logic, exported as handler()
```

`index.ts` is required by the Supabase edge runtime. Putting all logic in `<name>.ts` makes it findable by name in VS Code fuzzy search, keeps `serve()` isolated to one file, and lets tests import `handler` directly without mocking `serve()`.

When a function's DB access grows into a class (e.g. a table-scoped DB class), extract it into its own file alongside the handler:

```
supabase/functions/<name>/<table-name>-db.ts   ← DB class for a single table
```

### Shared utilities

All functions import from `supabase/functions/_shared/` — never inline raw `Deno.env.get()` or `createClient()` calls:

- `env.ts` — `loadSupabaseEnv()`, `loadSupabaseServiceEnv()` — fail-fast env loaders
- `supabase-admin.ts` — `createAdminClient(schema?)` — service-role client factory; always call inside the handler, never at module scope
- `errors.ts` — full typed error class table; `logError`, `errorBody`, `normalizeError`
- `logger.ts` — pino logger; use `logger.child({ fn: '<name>' })` at the top of each handler and pass it down — never use root `logger` inside a handler

### Error classes

| Class                       | HTTP | Code               |
| --------------------------- | ---- | ------------------ |
| `ValidationException`       | 400  | `VALIDATION_ERROR` |
| `AccessDeniedException`     | 403  | `ACCESS_DENIED`    |
| `UpgradeRequiredException`  | 402  | `UPGRADE_REQUIRED` |
| `ThrottlingException`       | 429  | `THROTTLED`        |
| `ResourceNotFoundException` | 404  | `NOT_FOUND`        |
| `ConflictException`         | 409  | `CONFLICT`         |
| `InternalServiceException`  | 500  | `INTERNAL_ERROR`   |
| `AiException`               | 502  | `AI_ERROR`         |
| `OpenAiException`           | 502  | `OPENAI_ERROR`     |
| `AnthropicException`        | 502  | `ANTHROPIC_ERROR`  |

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

**Never use the `unknown` type** outside of `catch` blocks. Ask for explicit permission before using it elsewhere. Use `Error` for caught errors (enabled by `useUnknownInCatchVariables: false` in `supabase/functions/deno.json`). Cast with `err as Error` at handler catch boundaries.

## Local development setup

skool-automations runs its own local Supabase stack on ports 54331–54333, independent of CareerSystems (54321–54324). Both projects can run simultaneously without conflict. Production uses a single shared Supabase instance; the `internal_cs_` migration prefix prevents conflicts in the shared tracking table.

**First-time setup (Docker required):**

```bash
pnpm db:start       # start local stack
pnpm migrate:local  # apply migrations
```

**Serve functions:**

```bash
pnpm dev:functions
# Functions at http://127.0.0.1:54331/functions/v1/<name>
```

`supabase functions serve` runs the edge runtime in Docker — `doppler run --` alone does not reach the container. `dev:functions` dumps Doppler secrets to `/tmp/skool-funcs.env` and passes that file via `--env-file`. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are auto-injected by the CLI from the local stack.

**Other lifecycle commands:**

```bash
pnpm db:stop    # stop containers
pnpm db:reset   # wipe and re-apply all migrations (useful after schema changes)
```

**Local resources:**

- Studio: http://127.0.0.1:54333
- DB: `postgresql://postgres:postgres@127.0.0.1:54332/postgres`

**Manual test curl:**

```bash
curl -X POST http://127.0.0.1:54331/functions/v1/fractional-onboarding-form-webhook \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: local-test-secret" \
  -d '{"data":{"Client full name":["Jane Doe"],"Email for Google Drive sharing":["jane@example.com"],"Email for Skool (leave blank if same as Drive email)":[""],"Program start date":["2026-06-01"],"Notes":[""]}}'
```

## Verification

After every change, run in this order:

1. `pnpm typecheck` — fix type errors (scripts/ via tsc + edge functions via `deno check`; use `pnpm typecheck:functions` to check only edge functions)
2. `pnpm test` — run unit tests; fix failures before proceeding
3. `pnpm format` — auto-format scripts/tests with Prettier; `pnpm format:functions` — auto-format edge functions with deno fmt (required before lint)
4. `pnpm lint` — fix lint errors

## Don't

- Don't hardcode secrets or commit `.env` files — secrets are injected via Supabase CLI locally and via GitHub Actions secrets in CI.
- **Never run `supabase db push` locally** — migrations are deployed exclusively via CI on push to main. Running it locally will push unapplied migrations directly to production.
- **Never use the `unknown` type** outside of `catch` blocks — ask for explicit permission before using it elsewhere. Use `Error` for caught errors (enabled by `useUnknownInCatchVariables: false` in `supabase/functions/deno.json`).
- Never set `verify_jwt = true` in `supabase/config.toml` for any function — ES256 JWTs will fail. Auth is handled in-function.
- Never import from a file that contains `Deno.serve()` — see Module Isolation rule above.

## Tests

All code changes must be accompanied by unit tests in `tests/unit/`. Edge function tests live in `tests/unit/functions/<name>.test.ts`.

The vitest config aliases Deno URL imports (`deno.land/std`, `esm.sh`, `npm:`) to mocks in `tests/__mocks__/`. When adding a new Deno-specific import to a function, add the corresponding mock alias to `vitest.config.ts`.
