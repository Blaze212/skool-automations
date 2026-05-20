# Screenshot Capture Setup

Captures screenshots with automatic URL tracking for the proof-log pipeline. When triggered, the script reads the active Chrome tab URL, opens an interactive crosshair selector, and saves the screenshot alongside a `url_index.json` sidecar file that maps each filename to its source URL.

## Prerequisites

- macOS
- Python 3
- Google Chrome

## One-time Setup

### 1. Find your Python path

```bash
which python3
```

Copy the output (e.g. `/usr/bin/python3` or `/opt/homebrew/bin/python3`).

### 2. Create the Automator Quick Action

1. Open **Automator** (Spotlight → "Automator")
2. Click **New Document** → choose **Quick Action**
3. Set **"Workflow receives"** to **"no input"** at the top
4. Search for **"Run Shell Script"** in the left panel and double-click to add it
5. Paste the following into the script box, substituting your Python path from Step 1:

```bash
/usr/bin/python3 /path/to/skool-automations/automations/proof-log/screenshot.py <path-to-save-screenshots-to>
```
```
Ex. /usr/bin/python3 /Users/john/skool-automations/automations/proof-log/screenshot.py  /Users/john/skool-automations/automations/screenshots/
```

6. **File → Save** → name it `Capture Screenshot`

### 3. Assign a keyboard shortcut

1. Open **System Settings → Keyboard → Keyboard Shortcuts**
2. Click **Services** in the left list
3. Scroll to **General** → find **Capture Screenshot**
4. Click **Add Shortcut** and press your desired key combo (e.g. `⌘⇧1`)

### 4. Grant permissions (first run only)

On first use, macOS will prompt Terminal to control Chrome. Click **Allow** in the Automation permissions dialog — it won't ask again.

## Usage

1. Navigate to the page you want to screenshot in Chrome
2. Press your keyboard shortcut from anywhere on your Mac
3. Drag to select the screenshot area — press **Esc** to cancel
4. Screenshot is saved to `<path-to-save-screenshots-to>` with a timestamped filename

## Output

Each run appends an entry to `<path-to-save-screenshots-to>/url_index.json`:

```json
{
  "screenshots": [
    {
      "filename": "screenshot_20260520_143022.png",
      "url": "https://skool.com/community/post/abc123",
      "captured_at": "2026-05-20T14:30:22"
    }
  ]
}
```

The proof-log pipeline reads `url_index.json` to look up the source URL for each screenshot by filename.



### Usage Once Setup
1. Login to skool in browser
2. Click on a post
3. Option + Shift + 1
4. Drag cursor for screenshot
5. Repeat steps 2-4 for all wins
6a. Let Claude pickup the screenshot in the to-redact folder
6b. Kick off /redact-skool-photos-v2 manually 
7. Manually verify google docs sheet. 