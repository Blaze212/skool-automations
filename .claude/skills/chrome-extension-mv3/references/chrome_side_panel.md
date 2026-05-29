---
name: chrome-side-panel
description: "chrome.sidePanel API best practices — manifest config, setPanelBehavior is code-only (not manifest), per-tab vs global, SW state warning"
metadata: 
  node_type: memory
  type: reference
  originSessionId: c555efb5-25ee-45b8-be2d-d52f7f9603eb
---

# chrome.sidePanel API (verified 2026-05-29)

## Manifest

```json
{
  "permissions": ["sidePanel"],
  "side_panel": { "default_path": "sidepanel/index.html" }
}
```

- `"sidePanel"` permission AND the `side_panel` key are both required.
- There is **no** `openPanelOnActionClick` field in the manifest. Older blog posts that say
  otherwise are wrong. It must be set from code (see below).

## Opening on toolbar-icon click

Set this once, from the background SW, typically on install:

```js
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});
```

Without this, clicking the toolbar icon does nothing — users see the popup or a `chrome://`
default panel.

## Per-tab vs global

- `default_path` in the manifest sets the global panel.
- `chrome.sidePanel.setOptions({tabId, path, enabled})` overrides per tab.
- Use per-tab when the panel content depends on the page (e.g. one UI on LinkedIn, another
  on `app.cmcareersystems.com`). For a single-UI extension, leave the default global.

## Lifecycle

- The side-panel document loads when first opened and unloads when closed.
- Top-level variables in `sidepanel.ts` survive while the panel is open but die on close.
- Persist anything that must outlive the panel to `chrome.storage.local`.

## Communicating with the service worker

- Side-panel JS and the SW share `chrome.runtime` (same extension origin).
- Use `chrome.runtime.sendMessage` for one-shot RPC.
- Use `chrome.runtime.connect` (port) for streams or for keeping the SW alive while the panel
  is doing async work — the panel sending messages over the port resets the SW idle timer
  (Chrome 116+).

## Cross-browser caveats

- Edge: same `chrome.sidePanel` API; usually works unchanged.
- Firefox: uses `sidebar_action` manifest key with different shape. Write an adapter or skip
  Firefox.

## When to apply

- Designing UI for a Web-Store-publishable extension where popup is too small for the
  surface area.
- Whenever the manifest grows a `"side_panel"` key — verify the matching `setPanelBehavior`
  call exists in `onInstalled`.

See also: [[chrome-mv3-sw-lifecycle]] for SW interactions; [[chrome-web-store-policy]] for
permission-disclosure requirements.
