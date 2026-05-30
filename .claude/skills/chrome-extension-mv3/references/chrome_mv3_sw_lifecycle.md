---
name: chrome-mv3-sw-lifecycle
description: "Chrome MV3 service worker lifecycle facts and gotchas — idle timeout, port behavior post-Chrome 116, keepalive patterns"
metadata: 
  node_type: memory
  type: reference
  originSessionId: c555efb5-25ee-45b8-be2d-d52f7f9603eb
---

# Chrome MV3 service worker lifecycle (verified 2026-05-29)

## Hard limits

- **30 s idle** → terminate. Any event or extension API call resets the timer.
- **5 min** per single request → terminate. (Exempt: `desktopCapture.chooseDesktopMedia`,
  `identity.launchWebAuthFlow`, `management.uninstall`, `permissions.request`.)
- **30 s** waiting for a `fetch()` response → terminate.
- `chrome.runtime.connectNative()` keeps the SW alive.
- Active WebSocket connections extend SW lifetime (Chrome 116+) — every message resets idle.

## Port behavior gotcha (Chrome 116+)

- **Opening a port does NOT reset the idle timer.**
- **Sending a message over a long-lived port DOES reset it.** Each message counts as activity.
- Implication: a long-lived port that sits idle still dies in 30 s. Either keep messages
  flowing, or design the protocol so SW death is fine (persist state to storage; resume on
  next spawn).

## State persistence rule

- Top-level variables in the SW vanish on termination.
- Persist anything that must survive across spawns to `chrome.storage.local`.
- Re-read storage at the top of every event handler — don't trust in-memory caches built by
  the previous spawn.

## Init pattern for MV3 handlers

Run init once per spawn via an `ensureInitialized()` guard, then `await` it at the top of
every `chrome.runtime.onMessage` / `onMessageExternal` / `onConnect` handler before touching
storage. Without this, the first message after spawn races init.

## When to apply

- Designing any extension that uses long-lived ports — assume SW dies during idle handshakes.
- Building bind-handshake / sync protocols — keep state in storage with a pending/confirmed
  state machine; never rely on SW staying alive between user gesture and async response.
- Setting up storage reads — gate on `ensureInitialized()`.

See also: [[chrome-externally-connectable]] for port-based messaging patterns.
