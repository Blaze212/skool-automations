---
name: chrome-storage
description: "chrome.storage.local quotas, atomicity, unlimitedStorage permission, and patterns for many small keys vs one large key"
metadata: 
  node_type: memory
  type: reference
  originSessionId: c555efb5-25ee-45b8-be2d-d52f7f9603eb
---

# chrome.storage.local (verified 2026-05-29)

## Quotas

- **`chrome.storage.local`: 10 MB** (5 MB in Chrome 113 and earlier).
- **`chrome.storage.sync`: ~100 KB total**, ~8 KB per item, 512 items max — cross-device.
- **`chrome.storage.session`: 10 MB**, in-memory only, cleared on browser close.
- **`"unlimitedStorage"` permission** removes the cap on `local` (and on IndexedDB). Triggers
  a Web Store "stores data without limit" disclosure — reviewers may ask why.

## Atomicity

- A single `set({key1, key2, key3})` call is atomic: either all three keys update or none do.
- Two concurrent `set()` calls are NOT serialized in a predictable order — last write wins
  per key. If you need read-modify-write, serialize with an async lock or use a single
  consolidated `set()`.

## Write performance

- Cost is roughly linear in serialized payload bytes, not key count.
- A single 1 MB key write costs about the same as 1000 × 1 KB key writes — but reading 1000
  keys with a single `.get([k1, k2, ...])` is much cheaper than 1000 separate reads.
- Pattern for hot+cold split: keep the hot index small (e.g. an array of IDs); store cold
  payloads under per-ID keys (`prefix_<id>`), read on demand.

## Error handling

- `set()` rejects with a quota-exceeded error when the operation would exceed the cap.
- Callers MUST handle: refuse new writes, surface to user, prompt to clear.
- `runtime.lastError` is also set (legacy callback API); the Promise API rejects.

## MV3 SW init pattern

```ts
let initPromise: Promise<void> | null = null;
function ensureInitialized(): Promise<void> {
  return initPromise ??= (async () => {
    const state = await chrome.storage.local.get([...DEFAULTS_KEYS]);
    const patch: Record<string, unknown> = {};
    for (const k of DEFAULTS_KEYS) {
      if (state[k] === undefined) patch[k] = DEFAULTS[k];
    }
    if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  })();
}

chrome.runtime.onMessage.addListener(async (msg, sender, send) => {
  await ensureInitialized();
  // …
});
```

- The cached `initPromise` is fine across the SW's lifetime; on a fresh spawn it's `null`
  again and reruns.
- Always `await` it before any storage read in event handlers.

## onChanged

- `chrome.storage.onChanged.addListener((changes, area) => ...)` fires for every `set()` and
  `remove()`.
- Each change has `{oldValue, newValue}` per key.
- Useful for keeping side-panel UI in sync with background writes without manual
  message-passing.

## When to apply

- Designing extension state. Default to `local`; reserve `sync` for tiny user preferences;
  use `session` for ephemeral SW-spawn state.
- Sizing decisions — if total payload could exceed 5–10 MB, split hot/cold or request
  `unlimitedStorage` (justify in Web Store review).
- Any read-modify-write pattern needs serialization — never assume isolation.

See also: [[chrome-mv3-sw-lifecycle]] for init pattern;
[[chrome-web-store-policy]] for permission disclosure cost.
