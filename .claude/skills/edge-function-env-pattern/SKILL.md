# Edge Function Env & Client Init Pattern

## Structure

New Supabase Edge Functions MUST follow a 3-layer structure:

```
supabase/functions/_shared/
  env.ts            ← domain-specific env loaders (typed, fail-fast)
  supabase-admin.ts ← service-role client factory (bypasses RLS)
  supabase-user.ts  ← request-scoped client factory (respects RLS)
  stripe.ts         ← Stripe client (if needed)
  ...
```

## Rule: domain-specific env loaders

Do NOT repeat raw `Deno.env.get()` checks inline in every function. Instead import from `_shared/env.ts`:

```ts
import { loadSupabaseEnv, loadStripeEnv } from '../_shared/env.ts'
// Only import what THIS function needs.
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = loadSupabaseEnv()
```

Available loaders: `loadSupabaseEnv()`, `loadOpenAiEnv()`, `loadStripeEnv()`, `loadResendEnv()`, `loadSentryEnv()`.

Add new loaders to `_shared/env.ts` when introducing a new external service.

## Rule: client factories

Do NOT inline `createClient(Deno.env.get(...), Deno.env.get(...))` in every function. Import from the shared factories:

```ts
// Service-role (bypasses RLS) — for admin/server-to-server work
import { createAdminClient } from '../_shared/supabase-admin.ts'
const supabase = createAdminClient()

// User-scoped (respects RLS) — for user-context work
import { createUserClient } from '../_shared/supabase-user.ts'
const supabase = createUserClient(req)
```

## Rule: function entrypoint shape

A function file should read like:

1. Import validated deps (clients, config)
2. Parse request
3. Authorize (`withAuth`)
4. Business logic
5. Return response

## What to avoid

- ❌ Repeating `Deno.env.get('SUPABASE_URL')` inline across multiple functions
- ❌ One giant global env schema that validates every service's vars at module load
- ❌ Hiding multiple env var checks inside `createClient()` calls so failures are mysterious
- ❌ Creating clients at module scope (env vars may not be set at import time)
