---
name: chrome-prompt-api
description: "Chrome built-in AI Prompt API (LanguageModel) — availability, create, prompt, monitor, AbortSignal, responseConstraint. Stable for extensions in Chrome 138+."
metadata: 
  node_type: memory
  type: reference
  originSessionId: c555efb5-25ee-45b8-be2d-d52f7f9603eb
---

# Chrome built-in AI Prompt API (verified 2026-05-29)

## Stability

- **Stable for Chrome extensions in Chrome 138+** — no flag, no Origin Trial, no special manifest permission required today.
- **Web pages**: still behind `chrome://flags/#prompt-api-for-gemini-nano` + registered Origin Trial.
- `responseConstraint` (structured output): Chrome 137+.

If a future Chrome version reintroduces an `aiLanguageModel`-style permission, the publishable
manifest will need to add it. CI guard should re-check the docs at build time and fail if drift.

## Availability states

```js
const state = await LanguageModel.availability();
// 'unavailable' | 'downloadable' | 'downloading' | 'available'
```

- `'available'` → use it.
- `'downloadable'` → ~2 GB model. Do NOT auto-trigger. Surface a user-facing CTA.
- `'downloading'` → treat as unavailable for this call; UI shows progress.
- `'unavailable'` → no model on this device / browser; fall back.

## Create + monitor (download progress)

```js
const session = await LanguageModel.create({
  signal: controller.signal,             // AbortSignal — destroys session if aborted
  monitor(m) {
    m.addEventListener('downloadprogress', e => {
      // e.loaded is a fraction 0–1
      ui.setProgress(Math.round(e.loaded * 100));
    });
  },
});
```

- Fresh `create()` per call to bound memory.
- `AbortSignal` cancels both the in-flight `create()` AND the future session.

## Prompt (one-shot)

```js
const result = await session.prompt(promptText, {
  signal: AbortSignal.timeout(10_000),   // mandatory for production
  responseConstraint: { /* JSON Schema or RegExp */ },
});
```

## Streaming variant

```js
const stream = session.promptStreaming(promptText, { signal: controller.signal });
for await (const chunk of stream) { /* ... */ }
```

## Input usage (quota check)

```js
const usage = await session.measureInputUsage(promptString, { signal });
// returns a number of tokens; check against session.inputQuota before prompting.
```

Always pass an `AbortSignal` to `measureInputUsage` too — it can hang.

## responseConstraint shapes

- JSON Schema object: ensures parseable structured output. Use for field extraction.
- RegExp: ensures the output matches a regular expression.

## Patterns for production extensions

1. **Never throw to the caller.** Wrap `availability()` / `create()` / `prompt()` /
   `measureInputUsage()` in try/catch and return `null` on any error path. AI failures
   should produce a fallback row, not break capture.
2. **10 s `AbortSignal.timeout()` on every `prompt()`.** Model hangs are silent otherwise.
3. **Cache `availability()` result for ~5 min.** Each call is non-trivial; the state doesn't
   change second-to-second. Invalidate on settings toggle or after download completes.
4. **Use `responseConstraint` (Chrome 137+) for JSON output**, not prompt-engineered JSON
   instructions. Schema enforcement is reliable; instruction-following is not.
5. **One session per prompt** for bounded memory; accept the create() latency cost.

## When to apply

- Any extension that uses on-device LLM extraction or generation.
- Whenever pre-existing code imports `LanguageModel` / `window.ai` / Prompt API.

See also: [[chrome-mv3-sw-lifecycle]] for how AI calls interact with SW timeouts (a 10s
prompt fits in the 30s idle window only if there's no other long-running work in the same
handler).
