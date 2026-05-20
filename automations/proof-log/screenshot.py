#!/usr/bin/env python3
"""
Screenshot capture tool with automatic Chrome URL detection and sidecar JSON tracking.

Usage:
    python capture_screenshot.py [output_dir]

Examples:
    python capture_screenshot.py
    python capture_screenshot.py ~/Desktop/screenshots

How it works:
    1. Reads the active Chrome tab URL automatically (no copy/paste needed)
    2. Opens the interactive screenshot crosshair selector (just like Preview)
    3. Saves the screenshot and logs filename + URL to url_index.json in the output folder
"""

import sys
import os
import json
import subprocess
from datetime import datetime


APPLESCRIPT_GET_CHROME_URL = """
tell application "Google Chrome"
    get URL of active tab of front window
end tell
"""


def get_chrome_url():
    """Grab the active Chrome tab URL via AppleScript."""
    result = subprocess.run(
        ["osascript", "-e", APPLESCRIPT_GET_CHROME_URL],
        capture_output=True,
        text=True
    )
    if result.returncode != 0:
        print("❌  Could not read Chrome URL.")
        print(f"    Make sure Chrome is open and you have an active tab.")
        print(f"    Error: {result.stderr.strip()}")
        sys.exit(1)
    return result.stdout.strip()


def get_output_dir(args):
    """Resolve output directory from args or default to Desktop/screenshots."""
    if len(args) >= 2:
        path = os.path.expanduser(args[1])
    else:
        path = os.path.expanduser("~/Desktop/screenshots")
    os.makedirs(path, exist_ok=True)
    return path


def generate_filename(output_dir):
    """Generate a timestamped unique filename."""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    base = f"screenshot_{timestamp}"
    filename = f"{base}.png"
    counter = 1
    while os.path.exists(os.path.join(output_dir, filename)):
        filename = f"{base}_{counter}.png"
        counter += 1
    return filename


def take_screenshot(filepath):
    """
    Launch macOS interactive screencapture (crosshair selector).
    User drags to select area, just like Preview.
    Returns True if screenshot was taken, False if cancelled.
    """
    subprocess.run(
        ["screencapture", "-i", "-x", filepath],  # -i = interactive, -x = no sound
        capture_output=True
    )
    return os.path.exists(filepath)


def load_sidecar(sidecar_path):
    """Load existing sidecar JSON or return empty structure."""
    if os.path.exists(sidecar_path):
        with open(sidecar_path, "r") as f:
            return json.load(f)
    return {"screenshots": []}


def save_sidecar(sidecar_path, data):
    """Write sidecar JSON with nice formatting."""
    with open(sidecar_path, "w") as f:
        json.dump(data, f, indent=2)


def main():
    if len(sys.argv) >= 2 and sys.argv[1] in ("-h", "--help"):
        print(__doc__)
        sys.exit(0)

    output_dir = get_output_dir(sys.argv)
    sidecar_path = os.path.join(output_dir, "url_index.json")

    # Grab Chrome URL before screencapture steals focus
    print("\n🔍  Reading active Chrome tab...")
    url = get_chrome_url()
    print(f"🔗  URL: {url}")

    filename = generate_filename(output_dir)
    filepath = os.path.join(output_dir, filename)

    print(f"\n📸  Select your screenshot area (Esc to cancel)...")
    taken = take_screenshot(filepath)

    if not taken:
        print("❌  Screenshot cancelled.")
        sys.exit(0)

    # Update sidecar
    data = load_sidecar(sidecar_path)
    entry = {
        "filename": filename,
        "url": url,
        "captured_at": datetime.now().isoformat(),
    }
    data["screenshots"].append(entry)
    save_sidecar(sidecar_path, data)

    print(f"✅  Saved:   {filename}")
    print(f"📄  Sidecar: {sidecar_path}")


if __name__ == "__main__":
    main()