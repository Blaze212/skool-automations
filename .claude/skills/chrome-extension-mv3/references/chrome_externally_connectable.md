---
name: chrome-externally-connectable
description: "externally_connectable manifest + chrome.runtime.connect / onMessageExternal security patterns. MessageSender validation, TLS channel id, port lifecycle."
metadata: 
  node_type: memory
  type: reference
  originSessionId: c555efb5-25ee-45b8-be2d-d52f7f9603eb
---

# externally_connectable + cross-origin messaging (verified 2026-05-29)

## Default posture (security)

- If the `externally_connectable` key is NOT in the manifest:
  - **All other extensions can connect** (default-allow for extensions).
  - **No web pages can connect** (default-deny for web).
- To accept messages from a specific web origin, declare it explicitly:

```json
{
  "externally_connectable": {
    "matches": ["https://app.example.com/*"],
    "accepts_tls_channel_id": true
  }
}
```

- To LOCK DOWN to a specific extension whitelist instead of default-allow:
  ```json
  "ids": ["abcdefghijklmnopqrstuvwxyzabcdef"]
  ```
  An empty `ids` array blocks all extensions.

## MessageSender validation (mandatory)

In `chrome.runtime.onMessageExternal` / `onConnectExternal`, validate the `sender` object
before trusting any message content:

```ts
function isTrustedSender(sender: chrome.runtime.MessageSender): boolean {
  // origin — set on the script context that opened the connection
  if (sender.origin !== 'https://app.example.com') return false;
  // tab presence — confirms this came from a page tab, not a background context
  if (!sender.tab?.id) return false;
  // (optional) tlsChannelId — strongest cryptographic sender identity
  // if (!sender.tlsChannelId) return false;
  return true;
}
```

### Available properties

- `sender.origin` — the page or frame's origin. Use this as your trust anchor for web-origin
  senders. Can be opaque (`about:blank`, sandboxed iframes) — treat opaque as untrusted.
- `sender.url` — full URL; can differ from origin.
- `sender.tab` — present only when the connection opened from a tab; absent for SW or
  popup-originated messages.
- `sender.tlsChannelId` — only populated when the page opted in via
  `connectInfo.includeTlsChannelId: true` AND the manifest declares
  `accepts_tls_channel_id: true`. Provides a cryptographic identifier tied to the user's TLS
  cert state — useful for rotating-token systems.

## Port lifecycle

```js
chrome.runtime.onConnectExternal.addListener(port => {
  if (!isTrustedSender(port.sender)) { port.disconnect(); return; }
  port.onMessage.addListener(msg => { /* ... */ });
  port.onDisconnect.addListener(() => {
    // cleanup port handle; check chrome.runtime.lastError for disconnect reason
  });
});
```

- Ports survive page navigations within the same SPA frame, but break on full reload.
- `port.disconnect()` fires `onDisconnect` on the OTHER end synchronously.
- **Opening a port does NOT keep the SW alive** (Chrome 116+); messages over the port do.

## Lock-down checklist for a publishable extension

1. Declare `externally_connectable.matches` with the exact origin (no wildcard subdomain
   unless required).
2. Validate `sender.origin` against the same origin string on every message.
3. Validate `sender.tab` presence — refuse messages from non-tab contexts unless explicitly
   expected.
4. Authenticate the message body with a bindingToken or equivalent shared secret — the
   sender check above proves *what page* sent the message, not *which user* on the page.
5. Consider `accepts_tls_channel_id` for high-value APIs (e.g. token rotation handshakes).

## Common pitfalls

- Forgetting to declare `externally_connectable` and assuming web pages can't reach you —
  WRONG for the extensions case, RIGHT for the web case. Declare to be explicit.
- Trusting `sender.url` instead of `sender.origin` — `url` is mutable via `pushState`;
  `origin` is not.
- Relying on `sender.id` for web-page senders — `id` is the extension ID; absent for web
  pages.

## When to apply

- Designing any ext ↔ web app handshake (binding, sync, rpc).
- Reviewing `externally_connectable` manifest entries for least-privilege.

See also: [[chrome-mv3-sw-lifecycle]] for port-and-SW interaction;
[[chrome-web-store-policy]] for permission justification.
