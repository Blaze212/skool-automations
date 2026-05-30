---
name: chrome-web-store-policy
description: "Chrome Web Store program policy essentials — privacy policy requirement, data category disclosure, Limited Use, AI extensions"
metadata: 
  node_type: memory
  type: reference
  originSessionId: c555efb5-25ee-45b8-be2d-d52f7f9603eb
---

# Chrome Web Store program policy (verified 2026-05-29)

## Privacy policy — mandatory triggers

A privacy policy URL is **required** when an extension requests any permission that grants
access to user data. Triggers (non-exhaustive):

- `tabs`, `cookies`, `history`, `bookmarks`, `identity`, `webRequest`, `downloads`
- Host permissions for specific domains (`https://*/*`, `https://example.com/*`, etc.)
- `storage` when storing user data
- `sidePanel` if the panel collects user data

The policy must accurately describe what data is collected, how it's used, who it's shared
with, and whether it's sold.

Per the 2026 LayerX report, ~71% of Web Store extensions don't publish a privacy policy —
having one is now a competitive review advantage AND a hard requirement for any extension
that captures even basic user-visible data (e.g. a name, a URL).

## Manifest data-category disclosure

Developers must declare data categories in the Web Store dashboard from Google's fixed list,
covering every data type the extension handles. Mismatches between the declared list and the
actual code's behavior are a common rejection reason.

## Limited Use

Permissions that collect personal/sensitive data may **only** be used to support or improve
the extension's stated single purpose or user-facing features. Specifically forbidden:

- Selling the data.
- Using it to ship ads not tied to the single purpose.
- Using it for credit-worthiness / lending decisions.
- Letting humans read the data unless the user explicitly consented for a specific incident,
  or the access is necessary for security, legal compliance, or an aggregated/anonymized
  analytics flow.

## Trader / non-trader status

EU-mandated. If the extension is part of a commercial product, declare "trader" with a
business address and contact. Non-trader is for individual non-commercial developers only.

## AI extension specifics

- On-device AI (Prompt API / `LanguageModel`) does NOT itself require a special permission
  today (Chrome 138+).
- Must still disclose in the privacy policy that the extension uses AI features, what data
  is fed to the model, and that the data stays on-device (if true).
- If the model EVER exfiltrates data (cloud fallback, telemetry on prompts) — disclose.

## Common rejection patterns

- Declared data category doesn't match what the code does.
- Privacy policy URL is missing, broken, or doesn't mention the specific data types.
- Permission requested but not used in code.
- Host permissions too broad (e.g. `<all_urls>` when only `linkedin.com` is needed).
- Single purpose violated (e.g. "LinkedIn capture" extension also reads Gmail).

## Pre-submission checklist

1. [ ] Privacy policy published at a stable URL covering every declared data category.
2. [ ] Manifest permissions are the minimal set used by the code (run a permission-drift
       check in CI).
3. [ ] Data categories declared in the dashboard match the code's behavior.
4. [ ] Trader status set if the extension is commercial.
5. [ ] Single-purpose statement is one sentence that matches the listing and the code.
6. [ ] Limited Use compliance — no resale, no off-purpose data use.
7. [ ] On-device AI: privacy policy mentions it; data flow described.

## When to apply

- Before any Chrome Web Store submission.
- When changing permissions or host permissions on an already-listed extension.
- When adding a new capture flow that touches a new data category.
