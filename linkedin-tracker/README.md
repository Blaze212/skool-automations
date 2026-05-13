# LinkedIn Activity Tracker

A Chrome extension that silently logs your LinkedIn outreach to a Google Sheet the moment you hit Send — no copy-paste, no manual entry. Works for both connection requests and direct messages.

---

## How it works

When you send a connection request or direct message on LinkedIn, the extension captures the recipient's name, headline, message type, and message text, then POSTs that data to a backend webhook which appends a row to your designated Google Sheet. The whole thing happens in the background with no visible interruption to your normal workflow.

---

## Prerequisites

- Google Chrome (or any Chromium-based browser)
- A copy of the extension's `dist/` folder (provided by Barton — see [Getting the extension](#getting-the-extension))
- An API key assigned to you (provided by Barton)
- A Google Sheet set up from the standard template (provided by Barton)

---

## Getting the extension

The extension is not listed on the Chrome Web Store. Barton will share the `dist/` folder with you directly (e.g. via Google Drive or a zip file). Download it and unzip it to a stable location on your computer — **do not move or delete this folder after installing**, as Chrome loads the extension directly from it.

Recommended location: `~/Documents/linkedin-tracker/` or a similar permanent folder.

---

## Installation

### Step 1 — Open Chrome Extensions

Open Chrome and go to:

```
chrome://extensions
```

Or navigate there via the menu: **⋮ → Extensions → Manage Extensions**.

### Step 2 — Enable Developer Mode

In the top-right corner of the Extensions page, toggle **Developer mode** on.

![Developer mode toggle in the top-right corner](https://developer.chrome.com/static/docs/extensions/get-started/tutorial/hello-world/image/extensions-page-e0d64d89a6acf_856.png)

### Step 3 — Load the extension

Click **Load unpacked** (top-left button that appears after enabling Developer mode).

Navigate to the `dist/` folder you downloaded and select it. The folder should contain:

```
dist/
├── manifest.json
├── content.js
├── background.js
└── popup/
    ├── popup.html
    └── popup.js
```

Click **Select Folder** (or **Open** on Mac).

### Step 4 — Confirm installation

You should now see **LinkedIn Activity Tracker** listed on the Extensions page with a green toggle indicating it is active.

Pin it to your toolbar for easy access: click the puzzle-piece icon (🧩) in the Chrome toolbar, find "LinkedIn Activity Tracker", and click the pin icon.

---

## Configuration

### Step 1 — Open the popup

Click the LinkedIn Tracker icon in your Chrome toolbar. The popup will open showing:

- A status indicator (**Not configured** in grey)
- An API key input field
- A Save button
- A debug mode toggle (leave this off unless troubleshooting)

### Step 2 — Enter your API key

Paste the API key Barton gave you into the input field and click **Save**.

The status indicator will change to **Configured** in green. You are ready to go.

> **Keep your API key private.** It is stored in Chrome's synced extension storage (tied to your Google account) and is never visible to other users. Do not share it or post it publicly.

---

## Using the extension

### Connection requests

1. Go to any LinkedIn profile
2. Click **Connect**
3. In the invite modal, click **Send invite** or **Send without a note**

The extension captures the event automatically. No further action needed.

> **Note:** Capturing the text of a custom note (when you click "Add a note" before sending) is not supported in this version. The row will still be logged with `message_type = Connection Request` and an empty Notes column.

### Direct messages

1. Open a LinkedIn conversation (either from your inbox or from a profile)
2. Type your message in the composer
3. Click the **Send** button **or** press **Enter**

The extension captures the recipient's name, headline, and your message text at the moment of send.

> **Shift+Enter** (new line) does **not** trigger logging — only a bare Enter or button click does.

---

## Your Google Sheet

The extension writes to the **Outreach Log** tab of your sheet. Here is what each column means:

| Column | Header         | Filled by                                                      |
| ------ | -------------- | -------------------------------------------------------------- |
| A      | _(blank)_      | —                                                              |
| B      | INDUSTRY       | You (fill in manually after the fact)                          |
| C      | COMPANY        | You (fill in manually)                                         |
| D      | ROLE TITLE     | You (fill in manually)                                         |
| E      | PERSON'S NAME  | Extension (auto)                                               |
| F      | PERSON'S TITLE | Extension (auto — full LinkedIn headline)                      |
| G      | BUCKET         | You (fill in manually)                                         |
| H      | MESSAGE TYPE   | Extension (auto — "Connection Request" or "Direct Message")    |
| I      | DATE           | Extension (auto — date the message was sent)                   |
| J      | STATUS         | Extension (auto — always "Sent")                               |
| K      | NOTES          | Extension (auto — message text; blank for connection requests) |

Columns B, C, D, and G are intentionally left blank by the extension. The idea is that you review the log periodically and fill in context (industry, company, role, bucket) when you have it, matching your existing pipeline management workflow.

---

## Popup status indicators

| Indicator                               | Meaning                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------ |
| **Configured** (green)                  | API key is saved; the extension will log outreach                        |
| **Not configured** (grey)               | No API key saved; the extension will not send any data                   |
| **Last logged: [timestamp]**            | The most recent successful log to your Sheet                             |
| **Last POST failed: [timestamp]** (red) | The last attempt to log failed — see [Troubleshooting](#troubleshooting) |

---

## Troubleshooting

### "Not configured" even after saving

- Make sure you clicked **Save** after entering the key
- Try closing and reopening the popup
- If the status still shows grey, re-enter the key and save again

### "Last POST failed" in red

This means the extension reached out to the server but something went wrong. Common causes:

1. **Wrong API key** — double-check with Barton that your key is correct and active
2. **No internet connection** — the extension needs a live connection at send time
3. **Server outage** — rare; try again or contact Barton

The failed event is **not retried automatically** — the row for that send was not logged. If accuracy is critical, note the details manually until the issue is resolved.

### A send happened but nothing appeared in the Sheet

1. Check the popup — does it show **Last logged** with a recent timestamp? If not, the POST failed (see above).
2. LinkedIn occasionally changes the `aria-label` attributes that the extension uses to detect send buttons. If this happens after a LinkedIn UI update, the extension may stop capturing events until it is updated. Contact Barton.
3. Make sure you are on `www.linkedin.com` — the extension only activates on that domain.

### Rows appear with empty Name or Title

LinkedIn's page structure is updated periodically. If the extension cannot find the name or headline element, it logs a partial row rather than dropping the event entirely. The extension will output a warning to the browser console — see [Using debug mode](#using-debug-mode) to help diagnose which selector broke.

### The extension disappeared from Chrome

This happens if Chrome's extension list was cleared (e.g. after a profile reset). Re-install using the same `dist/` folder by following the [Installation](#installation) steps again. Your API key is stored in Chrome sync storage tied to your Google account and should be restored automatically once you enter your key again.

---

## Using debug mode

Debug mode is an advanced diagnostic tool. Enable it only when you are actively troubleshooting a broken selector — not for normal use.

**What it does:** When debug mode is on and the extension cannot find an expected element (name, headline) during a send event, it attaches a `debug` field to the payload. This field includes:

- The `aria-label` and text content of the button that was clicked
- The outer HTML of the surrounding modal or conversation container (capped at 10,000 characters)
- The current page URL

**Privacy note:** The container HTML may include recent message thread content from both parties. Only enable debug mode when sharing a session with Barton for diagnostic purposes.

**To enable:** Open the popup, check the **Debug mode** checkbox. It saves automatically.

**To disable:** Uncheck the same checkbox.

---

## For Barton — client setup runbook

### Adding a new client

1. **Generate an API key:**

   ```js
   crypto.randomUUID();
   ```

2. **Insert a row into the database:**

   ```sql
   INSERT INTO internal_cs.linkedin_tracker_clients (api_key, sheet_id, label)
   VALUES ('<generated-uuid>', '<google-sheet-id>', '<Client Name>');
   ```

   INSERT INTO internal_cs.linkedin_tracker_clients (api_key, sheet_id, label)
   VALUES ('365A4BCA-59B9-460C-B6E3-BD751B7C23E8', '1m3weGKuymGFjAXPWKO2fjcBgswdD_ubHWrEdK17VcqM', 'barton-test');

   The Sheet ID is the long alphanumeric string in the Sheet's URL:
   `https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit`

3. **Share the Sheet with the service account:**
   - Open the client's Google Sheet
   - Click **Share**
   - Add the service account email (found in `GOOGLE_SERVICE_ACCOUNT_JSON` → `client_email`)
   - Set permission to **Editor**
   - Uncheck "Notify people" and click **Share**

4. **Send the client:**
   - Their API key
   - The `dist/` folder (or a link to download it)
   - A link to this README

5. **Verify end-to-end:**
   - Have the client install the extension and enter their API key
   - Ask them to send a test connection request on LinkedIn
   - Confirm a row appears in the **Outreach Log** tab of their Sheet within ~5 seconds
   - The popup should show a green **Configured** status and a **Last logged** timestamp

### Barton's own sheet

| Field    | Value                                          |
| -------- | ---------------------------------------------- |
| Sheet ID | `1m3weGKuymGFjAXPWKO2fjcBgswdD_ubHWrEdK17VcqM` |
| Label    | Barton                                         |

---

## Known limitations (V1)

- **Connection request note text is not captured.** If you add a custom note before sending a connection request, the note text will not appear in the Notes column. The row is still logged with an empty Notes field.
- **No deduplication.** If you somehow trigger a send twice for the same contact (e.g. a double-click), both rows will appear in the sheet.
- **No reply/response tracking.** The extension only logs outbound sends — it does not detect when someone replies or accepts a connection.
- **Company column is always blank.** The full headline is captured in the Title column (e.g. "Fractional CTO | SaaS | B2B"). Parsing that into a separate Company column is deferred to a future version.
- **Chrome/Chromium only.** Firefox and Safari are not supported.
