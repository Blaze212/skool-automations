---
name: ai-provider-usage
description: >
  Reference for calling AI providers (OpenAI, Anthropic) correctly in
  CareerSystems edge functions. Use this skill whenever writing code that
  calls an AI model, adding a new AI-powered feature, choosing between
  OpenAI and Anthropic, or reviewing code that makes AI calls. Covers which
  client class to use, how to pass UsageLoggingContext for token tracking,
  which models to use, how to handle structured JSON output, and how to
  expose clients through a Deps interface for testability. Never use the raw
  OpenAI or Anthropic SDKs directly.
---

# AI Provider Usage

All AI calls in edge functions must go through the shared client classes in
`supabase/functions/_shared/ai-client.ts`. **Never instantiate `new OpenAI()`
or `new Anthropic()` directly** — raw SDK calls bypass retry logic, token
tracking, usage logging, and the mock-injection pattern needed for testing.
Prefer typed client calls using completeJson over complete in almost all cases.

---

## The three client classes

| Class                   | API                     | Use when                                           |
| ----------------------- | ----------------------- | -------------------------------------------------- |
| `OpenAiChatClient`      | OpenAI Chat Completions | Fast generation, simple prompts, JSON extraction   |
| `OpenAiResponsesClient` | OpenAI Responses API    | Prompts that benefit from extended reasoning       |
| `AnthropicClient`       | Anthropic Messages      | High-quality synthesis, complex reasoning, grading |

All three implement the same `AiClient` interface — swap freely in tests.

---

## Current models

These are the current preferred models. Always look up the latest before
hardcoding a model name; they change frequently.

| Task                        | Model              | Client                  |
| --------------------------- | ------------------ | ----------------------- |
| Fast extraction / parsing   | `gpt-5.4-mini`     | `OpenAiChatClient`      |
| High-quality generation     | `gpt-5.4`          | `OpenAiChatClient`      |
| Extended reasoning          | `gpt-5.4`          | `OpenAiResponsesClient` |
| Complex synthesis / grading | `claude-opus-4-7`  | `AnthropicClient`       |
| Fast/cheap classification   | `claude-haiku-4-5` | `AnthropicClient`       |

---

## Always pass UsageLoggingContext

Every production AI call must pass a `UsageLoggingContext` so token usage is
recorded in `ai_usage_log`. This is how we track costs and debug AI behaviour.

```typescript
import { OpenAiChatClient, AnthropicClient } from '../_shared/ai-client.ts'

// Inside the request handler, after userId is known:
const usageCtx = {
  userId, // string | null — from withAuth
  sessionId, // optional — a request/pipeline ID for grouping calls
  feature: 'my-feature', // snake_case feature name, shown in cost dashboards
  log, // the child logger for this request
}

const aiClient = new OpenAiChatClient('gpt-5.2', usageCtx)
const anthropicClient = new AnthropicClient('claude-opus-4-6', 4096, usageCtx)
```

Without `usageCtx`, token counts are not recorded and cost monitoring is blind.
The only valid exception is in test code, where you pass a mock logger instead.

---

## Text completion

Use `client.complete(system, userPrompt)` for free-form text output:

```typescript
const result = await aiClient.complete(
  'You are a career coach. Be concise.',
  `Summarize this job description: ${jobDescription}`,
)

const text = result.text // the response string
const tokens = result.tokens // { input, output, model }
```

---

## Structured JSON output

Use `client.completeJson<T>(system, userPrompt, schemaName, schema)` when you
need typed structured data. This uses JSON Schema mode — the model is constrained
to return valid JSON matching your schema.

```typescript
// Define the schema (JSON Schema draft-7 compatible)
const MY_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'number' },
    reason: { type: 'string' },
  },
  required: ['score', 'reason'],
  additionalProperties: false,
}

type MyResult = { score: number; reason: string }

const { data, tokens } = await aiClient.completeJson<MyResult>(
  'You are a relevance scorer.',
  `Score this job on relevance to the resume: ${jd}`,
  'relevance_score', // schemaName — must be snake_case, no spaces
  MY_SCHEMA,
)

// data is typed as MyResult
console.log(data.score, data.reason)
```

For complex schemas, define them in a separate `schemas/` file alongside the
function (see `supabase/functions/ai-message-generator/pipeline/schemas/` for
examples).

---

## Expose clients through a Deps interface

Functions that call AI must expose their clients through an injectable `Deps`
interface so integ tests can swap in mocks without hitting real APIs.

```typescript
// types.ts or at the top of the pipeline file
import type { AiClient } from '../_shared/ai-client.ts'

export interface MyFunctionDeps {
  extractClient?: AiClient
  synthesisClient?: AiClient
}

// pipeline.ts
export async function runPipeline(
  input: MyInput,
  usageCtx: UsageLoggingContext,
  deps?: MyFunctionDeps,
): Promise<MyOutput> {
  // Use injected clients in tests; create real ones in production
  const { OpenAiChatClient, AnthropicClient } = await import('../_shared/ai-client.ts')
  const extract = deps?.extractClient ?? new OpenAiChatClient('gpt-5.2', usageCtx)
  const synth = deps?.synthesisClient ?? new AnthropicClient('claude-opus-4-6', 4096, usageCtx)

  // ... use extract and synth ...
}
```

The dynamic import (`await import(...)`) is intentional — it prevents Deno from
loading the real SDK in test environments where the import path is mocked.

---

## Anthropic-specific: prompt caching

For functions that run in tight loops (cron jobs, batch processing) where the
system prompt is reused across many calls, enable prompt caching to reduce cost:

```typescript
const client = new AnthropicClient(
  'claude-opus-4-6',
  4096,
  usageCtx,
  true, // cacheSystemPrompt — attaches cache_control: { type: 'ephemeral' }
)
```

Only use this when the same system prompt is called many times within the 5-minute
Anthropic cache TTL. For one-off requests it has no effect and costs 10% more.

---

## Error handling

The client classes throw typed exceptions automatically on failure:

- `OpenAiException` for OpenAI errors
- `AnthropicException` for Anthropic errors

Do not wrap AI calls in their own try/catch unless you need specific recovery
logic. Let the exceptions propagate to the handler's inner catch block, which
calls `logError()` and returns the appropriate HTTP response.

```typescript
// Bad — unnecessary wrapping, hides the error type
try {
  const result = await aiClient.complete(system, prompt)
} catch (err) {
  throw new InternalServiceException({ message: 'AI failed', sourceError: err })
}

// Good — let the typed exception propagate
const result = await aiClient.complete(system, prompt)
// OpenAiException or AnthropicException will surface at the handler boundary
```

The exception is when you want to add context-specific information before
re-throwing:

```typescript
try {
  const result = await aiClient.completeJson<MyType>(system, prompt, 'my_schema', MY_SCHEMA)
} catch (err) {
  throw new OpenAiException({
    message: `Failed to parse JD for job ${jobId}`,
    sourceError: err,
  })
}
```

---

## What NOT to do

```typescript
// ❌ Raw OpenAI SDK — no retry, no token tracking, no mock injection
import OpenAI from 'https://esm.sh/openai@4'
const openai = new OpenAI({ apiKey: Deno.env.get('OPENAI_API_KEY') })
const completion = await openai.chat.completions.create({ ... })

// ❌ Raw Anthropic SDK
import Anthropic from '@anthropic-ai/sdk'
const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY') })
const msg = await anthropic.messages.create({ ... })

// ❌ Client without UsageLoggingContext in production
const client = new OpenAiChatClient('gpt-5.2', log)  // log only, no usage tracking

// ✅ Correct
const usageCtx = { userId, feature: 'my-feature', log }
const client = new OpenAiChatClient('gpt-5.2', usageCtx)
```

---

## Quick checklist

- [ ] Using `OpenAiChatClient`, `OpenAiResponsesClient`, or `AnthropicClient` — not raw SDKs
- [ ] `UsageLoggingContext` passed with `userId`, `feature`, and `log`
- [ ] Client exposed through a `Deps` interface for test injection
- [ ] JSON output uses `completeJson<T>()` with a typed schema, not manual `JSON.parse`
- [ ] Exceptions propagate to the handler's inner catch — no unnecessary wrapping
