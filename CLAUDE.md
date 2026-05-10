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
- `errors.ts` — `ValidationException`, `AccessDeniedException`, `InternalServiceException`, `logError`, `errorBody`
- `logger.ts` — structured child logger; use `logger.child({ fn: '<name>' })` at the top of each handler

### Function shape

Follow the `/edge-function-env-pattern` and `/new-edge-function` skills. Key rules:

1. Webhook functions validate `X-Webhook-Secret` header before any processing
2. Two-layer try/catch: outer for framework panics, inner for application errors
3. Throw typed error classes (`ValidationException`, etc.) — never `new Error(...)`
4. All catch blocks call `logError(err, ...)` — no bare `console.error`
5. `verify_jwt = false` in `config.toml` for every function (ES256 JWTs; auth is handled in-function)
6. Create Supabase clients inside the handler, not at module scope
