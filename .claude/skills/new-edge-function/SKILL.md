---
name: new-edge-function
description: >
  Scaffold a new Supabase Edge Function for the CareerSystems project. Use this
  skill whenever the user wants to create a new edge function, add a new backend
  endpoint, or implement a new server-side feature as a Supabase function. Also
  trigger when implementing a spec that mentions a new function, API endpoint, or
  backend service. Covers auth wiring, pino logging, config.toml registration,
  unit test stub, and ADR creation.
---

# New Edge Function Skill

This skill scaffolds a production-ready Supabase Edge Function for CareerSystems,
wiring in the correct auth pattern, logger, config entry, and unit test — so you
don't accidentally break prod with a wrong `verify_jwt` flag or forget the ADR.

**Workspace root:** `/Users/barton/workspaces/careersystems/workspace`

---

## Step 1 — Gather intent

Before writing anything, collect:

1. **Function name** (kebab-case, e.g. `connection-finder`)
2. **Responsibility** — one sentence. Functions must have ONE responsibility.
3. **Auth type** — pick one:
   - `user` — called by authenticated members (uses `withAuth()`)
   - `service` — internal server-to-server (uses `isServiceRoleBearer()`)
   - `webhook` — external webhook with shared secret header
4. **Input/output shape** — what does the request body look like? What does it return?
5. **Does it need a DB migration?** — if yes, run `/new-migration` after this skill.

If you're implementing a spec, read the spec file first and extract these answers
from it before asking the user.

---

## Step 2 — Create the function file

Create `supabase/functions/<name>/index.ts`.

### Template for `user` auth functions

```typescript
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { corsHeadersFor, withAuth } from '../_shared/auth.ts'
import { errorBody, logError, ValidationException } from '../_shared/errors.ts'
import { logger } from '../_shared/logger.ts'
import { Sentry } from '../_shared/sentry.ts'

serve(async (req: Request) => {
  // Outer catch: last-resort alarm for framework panics / Deno crashes
  try {
    return await withAuth(req, async (userId) => {
      // Inner catch: all normal application errors
      try {
        const log = logger.child({ userId, fn: '<name>' })

        const body = await req.json().catch(() => {
          throw new ValidationException({ message: 'Request body must be valid JSON' })
        })
        // TODO: validate body shape

        log.info({ body }, 'request received')

        // --- implementation ---

        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...corsHeadersFor(req), 'Content-Type': 'application/json' },
        })
      } catch (err) {
        const normalized = logError(err, '<name> failed', { userId })
        return new Response(JSON.stringify(errorBody(normalized)), {
          status: normalized.status,
          headers: { ...corsHeadersFor(req), 'Content-Type': 'application/json' },
        })
      }
    })
  } catch (err) {
    Sentry.captureException(err)
    // @ts-ignore — EdgeRuntime is available in Supabase edge functions
    EdgeRuntime.waitUntil(Sentry.flush(2000))
    return new Response(JSON.stringify(errorBody(err)), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
```

### Template for `service` auth functions

Same two-layer structure, but replace `withAuth(req, ...)` with an upfront service
role check before the outer try:

```typescript
import { isServiceRoleRequest } from '../_shared/auth.ts'
import { AccessDeniedException, errorBody } from '../_shared/errors.ts'
// ...
if (!isServiceRoleRequest(req)) {
  return new Response(JSON.stringify(errorBody(new AccessDeniedException())), { status: 403 })
}
const log = logger.child({ fn: '<name>' })
// then wrap the rest in the same try { ... } catch (outer) pattern
```

### Dispatching to a `service` auth function from another function

When one edge function calls another via `fetch`, always send the key from
`loadSupabaseServiceEnv().SUPABASE_SERVICE_ROLE_KEY` — **never** `getServiceRoleKey()`.

```typescript
import { loadSupabaseServiceEnv } from '../_shared/env.ts'

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = loadSupabaseServiceEnv()

await fetch(`${SUPABASE_URL}/functions/v1/<target-function>`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    apikey: SUPABASE_SERVICE_ROLE_KEY,
  },
  body: JSON.stringify({ ... }),
})
```

**Why:** `getServiceRoleKey()` returns the first non-empty candidate from a list of
env var names (e.g. `SERVICE_ROLE_KEY` from Doppler, then `SUPABASE_SERVICE_ROLE_KEY`
auto-injected by Supabase). If Doppler provides a new-format key (`sb_secret__...`)
while Supabase auto-injects an old JWT-format key, the two values differ. The
receiving function's `isServiceRoleBearer` compares the incoming token against its
own candidate list — and the mismatch causes a 401 even though the Supabase gateway
accepted the key. Using `SUPABASE_SERVICE_ROLE_KEY` directly (auto-injected, same
value in every function) guarantees both sides always agree.

### Template for `webhook` functions

```typescript
const secret = Deno.env.get('WEBHOOK_SECRET')
const incomingSecret = req.headers.get('X-Webhook-Secret')
if (!secret || incomingSecret !== secret) {
  return new Response('Unauthorized', { status: 401 })
}
const log = logger.child({ fn: '<name>' })
```

**Key logger rules:**

- Create `log = logger.child({ userId, fn: '<name>' })` at the top of each handler
- Pass `log` down to sub-functions; never use root `logger` inside handlers
- Use `log.info(...)` for normal flow, `log.error({ err }, ...)` for errors

---

## Step 3 — Register in config.toml

Add to `supabase/config.toml`:

```toml
[functions.<name>]
verify_jwt = false
```

**Always `verify_jwt = false`.** The project uses ES256 asymmetric JWTs; the
built-in verification only works with legacy HS256 keys and will reject every real
user token. Auth is handled inside the function via `withAuth()`.

---

## Step 4 — Create the unit test

Create `tests/unit/functions/<name>.test.ts`.

Minimum test structure:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock Deno globals before importing the function
vi.mock('https://deno.land/std@0.168.0/http/server.ts', () => ({
  serve: vi.fn(),
}))

describe('<name>', () => {
  it('returns 401 when no auth token provided', async () => {
    const req = new Request('http://localhost/functions/v1/<name>', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    // test the handler directly
  })

  it('returns expected shape on valid request', async () => {
    // happy path test
  })
})
```

Look at existing tests in `tests/unit/functions/` for patterns — especially how
`withAuth` is mocked. Mirror those patterns rather than inventing new ones.

---

## Step 5 — Write the ADR

Create `docs/adr/<YYYY-MM-DD>-<name>.md` following the template in
`docs/architecture_decision_record.md`. At minimum cover:

- **Context:** what problem this function solves
- **Decision:** auth type chosen and why
- **Consequences:** any caveats (rate limits, cost, dependencies)

---

## Step 6 — Verify

Run in order:

```bash
pnpm typecheck:functions   # Deno type-check the new function
pnpm typecheck             # full workspace typecheck
pnpm format
pnpm lint
```

Fix any errors before declaring done.

---

## AI calls — non-negotiable rules

If the function calls any AI model, follow the **`ai-provider-usage`** skill. Key requirements:

- Use `OpenAiChatClient`, `OpenAiResponsesClient`, or `AnthropicClient` — never raw `new OpenAI()` / `new Anthropic()`
- Always pass `UsageLoggingContext` with `{ userId, feature, log }` for token tracking
- Expose clients through a `Deps` interface so integ tests can inject mocks
- Use `completeJson<T>()` with a typed schema for structured output

---

## Error handling — non-negotiable rules

Before submitting, verify the function follows the **`edge-function-error-handling`**
skill. Key requirements:

- All thrown errors use a typed class from `_shared/errors.ts`
  (`ValidationException`, `AccessDeniedException`, `InternalServiceException`, etc.)
- Every `catch` block either calls `logError(err, ...)` or rethrows — no empty catches
  except `Sentry.flush(2000).catch(() => {})`
- All error responses use `errorBody(normalized)` and `normalized.status`
- `sourceError: err` is passed when wrapping a caught error
- Sub-functions throw typed errors; only the top-level handler logs and returns

---

## Step 7 — Integration tests

Follow the **`integ-test-edge-function`** skill for full guidance.

The key constraint: **every integ test must mock any AI or external API call that
incurs cost.** The function must expose its dependencies through an injectable
`Deps` interface so tests can swap in mock implementations.

Quick checklist before writing integ tests:

1. Does the function have a `Deps` interface with injectable AI/search clients?
   If not, refactor to add one first (see `ai-message-generator` for the pattern).
2. Create `tests/integ/<name>-mock.test.ts`
3. Build a `makeMockDeps()` factory with `vi.fn()` returning realistic stub data
4. Cover: auth gate (401/403), input validation (400), happy path (200 + DB assertion),
   error handling (500), determinism (same input → same output)
5. Always clean up test users in `afterAll`

---

## Step 8 — E2E tests

Follow the **`e2e-test-edge-function`** skill for full guidance.

E2E tests run the real portal in a browser via Playwright — no mocks. They verify
the feature works end-to-end from the user's perspective.

Quick checklist before writing E2E tests:

1. Number the spec file sequentially: `tests/e2e/<NN>-<name>.spec.ts`
2. Use `loginViaUI` and `setupTestUser` from the shared helpers
3. Always call `test.skip(...)` if `E2E_1_PROD_EMAIL` isn't set
4. Prefer `getByRole` / `getByText` / `getByPlaceholder` over CSS selectors
5. Set explicit `{ timeout }` on `expect(...).toBeVisible()` for async operations
6. Clean up in `afterEach` — delete ephemeral users, reset pre-existing ones

---

## Checklist

- [ ] `supabase/functions/<name>/index.ts` created
- [ ] `verify_jwt = false` added to `supabase/config.toml`
- [ ] Logger uses child logger with `{ userId, fn }` context
- [ ] Auth type correctly applied (`withAuth` / `isServiceRoleBearer` / secret header)
- [ ] Unit test created in `tests/unit/functions/<name>.test.ts`
- [ ] Integ test created in `tests/integ/<name>-mock.test.ts` (mock deps, no real API calls)
- [ ] E2E test created in `tests/e2e/<NN>-<name>.spec.ts`
- [ ] ADR created in `docs/adr/`
- [ ] `pnpm typecheck:functions` passes
