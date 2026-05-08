---
name: edge-function-error-handling
description: >
  Reference for correct error handling patterns in CareerSystems Supabase Edge
  Functions. Use this skill when writing or reviewing error handling in edge
  functions, adding a new try/catch block, deciding which exception class to
  throw, or reviewing code that catches errors. Also trigger when the user asks
  "how should I handle errors", "what error class should I use", or "is this
  catch block correct".
---

# Edge Function Error Handling

The project has a complete, typed error handling system in
`supabase/functions/_shared/errors.ts`. **Always use it. Never invent ad-hoc
error shapes.**

---

## The golden rules

1. **Never throw plain `Error`** — throw a typed exception class instead.
2. **Never swallow errors silently** — the only legitimate empty catch is
   `Sentry.flush(2000).catch(() => {})` (fire-and-forget telemetry flush).
3. **Always log before returning** — use `logError()` which logs + Sentry-captures
   in one call.
4. **Always use `errorBody()` for response payloads** — never hand-craft
   `{ error: "something" }` shapes.
5. **Pass `sourceError`** when wrapping a caught error — it preserves the original
   stack trace in logs.

---

## Exception classes

All live in `supabase/functions/_shared/errors.ts`. Import what you need:

```typescript
import {
  ValidationException,
  AccessDeniedException,
  UpgradeRequiredException,
  ThrottlingException,
  ResurceNotFoundException,
  ConflictException,
  InternalServiceException,
  AiException,
  OpenAiException,
  AnthropicException,
  normalizeError,
  errorBody,
  logError,
} from '../_shared/errors.ts'
```

### Which class to use

| Situation                                     | Class                      | HTTP |
| --------------------------------------------- | -------------------------- | ---- |
| Bad request body / missing field / wrong type | `ValidationException`      | 400  |
| Missing auth, wrong user, no feature access   | `AccessDeniedException`    | 403  |
| Free quota exhausted, upgrade needed          | `UpgradeRequiredException` | 402  |
| Rate limited                                  | `ThrottlingException`      | 429  |
| DB row not found                              | `ResurceNotFoundException` | 404  |
| DB conflict (duplicate, FK violation)         | `ConflictException`        | 409  |
| Unexpected server error, unclassified failure | `InternalServiceException` | 500  |
| Generic AI provider error                     | `AiException`              | 502  |
| OpenAI call failed                            | `OpenAiException`          | 502  |
| Anthropic call failed                         | `AnthropicException`       | 502  |

### Adding a new error code

If none of the above fit, add a new `AppErrorCode` entry and class to
`_shared/errors.ts` — do not invent a one-off error shape in the function.

---

## Throwing typed errors

```typescript
// Bad
throw new Error('User does not have access')

// Good
throw new AccessDeniedException({ message: 'connections feature access required' })

// Good — wrapping a source error
throw new OpenAiException({
  message: 'Failed to parse job description',
  sourceError: err, // preserves original stack in logs
})
```

---

## The two-layer try/catch pattern

Every edge function needs **two** catch boundaries, not one.

```typescript
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { corsHeadersFor, withAuth } from '../_shared/auth.ts'
import { errorBody, logError, ValidationException } from '../_shared/errors.ts'
import { Sentry } from '../_shared/sentry.ts'

serve(async (req: Request) => {
  // ── Outer catch: framework panics that escape withAuth ────────────────────
  try {
    return await withAuth(req, async (userId) => {
      // ── Inner catch: all normal application errors ────────────────────────
      try {
        const log = logger.child({ userId, fn: 'my-function' })

        const body = await req.json().catch(() => {
          throw new ValidationException({ message: 'Request body must be valid JSON' })
        })

        if (!body.requiredField) {
          throw new ValidationException({ message: 'requiredField is required' })
        }

        // ... implementation ...

        return new Response(JSON.stringify({ ok: true, data: result }), {
          headers: { ...corsHeadersFor(req), 'Content-Type': 'application/json' },
        })
      } catch (err) {
        const normalized = logError(err, 'my-function failed', { userId })
        return new Response(JSON.stringify(errorBody(normalized)), {
          status: normalized.status,
          headers: { ...corsHeadersFor(req), 'Content-Type': 'application/json' },
        })
      }
    })
  } catch (err) {
    // Last-resort alarm for unexpected crashes (Deno panics, import failures, etc.)
    Sentry.captureException(err)
    // @ts-ignore — EdgeRuntime is available in Supabase edge functions
    EdgeRuntime.waitUntil(Sentry.flush(2000))
    return new Response(JSON.stringify(errorBody(err)), {
      status: 500,
      headers: { ...corsHeadersFor(req), 'Content-Type': 'application/json' },
    })
  }
})
```

### Why two layers?

| Layer     | Catches                                                                           | Action                                                                        |
| --------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Inner** | All application errors (validation, auth, DB, AI)                                 | `logError()` → structured JSON response                                       |
| **Outer** | Framework panics, Deno crashes, import failures, anything that escapes `withAuth` | `Sentry.captureException` + `EdgeRuntime.waitUntil(Sentry.flush(2000))` → 500 |

`logError()` already calls `Sentry.captureException` for 5xx errors — the inner
catch handles alarming for expected server errors. The outer catch is for the
unexpected. **It must never be omitted.** Without it, a framework-level failure
produces no alert and no structured response.

---

## Logging errors in sub-functions

In pipeline steps or helper functions that aren't the top-level handler, throw
typed exceptions — don't log at the call site. Let the handler's catch block do
the logging once.

```typescript
// Bad — logs at every level, duplicates entries
async function fetchJobData(jobId: string, log: Logger) {
  const { data, error } = await supabase.from('jobs').select('*').eq('id', jobId).single()
  if (error) {
    log.error({ err: error }, 'DB query failed') // ← log here AND in handler = double log
    throw new InternalServiceException({ message: 'Job fetch failed', sourceError: error })
  }
  return data
}

// Good — throw typed, log once at the boundary
async function fetchJobData(jobId: string) {
  const { data, error } = await supabase.from('jobs').select('*').eq('id', jobId).single()
  if (error) {
    throw new InternalServiceException({ message: 'Job fetch failed', sourceError: error })
  }
  if (!data) {
    throw new ResurceNotFoundException({ message: `Job ${jobId} not found` })
  }
  return data
}
```

---

## The only legitimate empty catch

```typescript
// This is OK — fire-and-forget telemetry flush, failure is irrelevant
await Sentry.flush(2000).catch(() => {})

// Everything else must log or rethrow
```

---

## Response shape contract

All error responses from edge functions must use `errorBody()`:

```typescript
// errorBody() always returns:
// { success: false, error: string, code: AppErrorCode }

return new Response(JSON.stringify(errorBody(normalized)), {
  status: normalized.status,
  headers: { ...corsHeadersFor(req), 'Content-Type': 'application/json' },
})
```

The frontend and integ tests assert on `body.code` (e.g. `'ACCESS_DENIED'`,
`'VALIDATION_ERROR'`). Never return `{ error: "some message" }` without a `code`.

---

## Handling Supabase query errors

Supabase queries return `{ data, error }` — always check the error:

```typescript
const { data, error } = await supabase.from('table').select('*').eq('id', id).maybeSingle()

if (error) {
  throw new InternalServiceException({
    message: 'Failed to load table row',
    sourceError: error,
  })
}

// For .single() (not .maybeSingle()), also check for null:
if (!data) {
  throw new ResurceNotFoundException({ message: `Row ${id} not found` })
}
```

Use `.maybeSingle()` when the row may legitimately not exist (returns `null`).
Use `.single()` only when the row must exist (throws if not found).

---

## Handling JSON parse errors

```typescript
// Never let req.json() throw an untyped error
const body = await req.json().catch(() => {
  throw new ValidationException({ message: 'Request body must be valid JSON' })
})
```

---

## Quick checklist when writing a catch block

- [ ] Is the caught error wrapped in a typed exception class?
- [ ] Is `sourceError: err` passed so the original stack is preserved?
- [ ] Is `logError()` called (not `log.error()` directly) at the handler boundary?
- [ ] Does the response use `errorBody(normalized)` and `normalized.status`?
- [ ] Is this catch block empty? If yes — is it a Sentry flush? If not, add logging.
