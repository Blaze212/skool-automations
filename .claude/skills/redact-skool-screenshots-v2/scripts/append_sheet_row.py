#!/usr/bin/env python3
"""
Append one proof log row to the Overview sheet, matching values to columns
by header name rather than absolute position.

Usage:
    python3 append_sheet_row.py <sheet_id> '<row_json>'

row_json keys (all strings):
    date, post_url, title,
    area, level, function, status, main_objection,
    trigger, behavior, outcome, friction_surprise, artifact_candidate,
    post_text, original_url, png_url, svg_url

date must be pre-formatted as MM/DD/YYYY.
Reads GOOGLE_SERVICE_ACCOUNT_JSON from the environment.
Prints "OK" to stdout on success.

Column matching (header → key, case-insensitive, punctuation-stripped):
    date              → date (rendered as =HYPERLINK(post_url,"date") if post_url set)
    screenshot        → original_url  (HYPERLINK)
    redacted png      → png_url       (HYPERLINK)
    redacted svg*     → svg_url       (HYPERLINK)
    area              → area
    level             → level
    function          → function
    status            → status
    trigger           → trigger
    behavior          → behavior
    outcome           → outcome
    friction*         → friction_surprise
    artifact*         → artifact_candidate
    main objection    → main_objection
    post text         → post_text
"""
from __future__ import annotations

import json
import os
import re
import sys

try:
    from googleapiclient.discovery import build
    from google.oauth2.service_account import Credentials
except ImportError:
    import subprocess
    subprocess.check_call(
        [sys.executable, "-m", "pip", "install",
         "google-api-python-client", "google-auth",
         "--break-system-packages", "-q"]
    )
    from googleapiclient.discovery import build
    from google.oauth2.service_account import Credentials


SCOPES    = ["https://www.googleapis.com/auth/spreadsheets"]
TAB       = "Overview"
HEADER_ROW = 1  # 1-based


def _normalize(s: str) -> str:
    """Lowercase, strip punctuation/extra spaces — used for fuzzy header matching."""
    return re.sub(r"[^a-z0-9 ]", "", s.lower()).strip()


# Maps normalised header prefix → row_json key
COLUMN_MAP: list[tuple[str, str]] = [
    ("date",            "date"),          # rendered as hyperlink below
    ("screenshot",      "original_url"),
    ("redacted png",    "png_url"),
    ("redacted svg",    "svg_url"),
    ("area",            "area"),
    ("level",           "level"),
    ("function",        "function"),
    ("status",          "status"),
    ("trigger",         "trigger"),
    ("behavior",        "behavior"),
    ("outcome",         "outcome"),
    ("friction",        "friction_surprise"),
    ("artifact",        "artifact_candidate"),
    ("main objection",  "main_objection"),
    ("post text",       "post_text"),
]


def _resolve_key(header: str) -> str | None:
    norm = _normalize(header)
    for prefix, key in COLUMN_MAP:
        if norm.startswith(prefix):
            return key
    return None


def _cell_value(key: str, row: dict) -> str:
    raw = row.get(key, "")
    if not raw:
        return ""

    if key == "date":
        post_url = row.get("post_url", "")
        return f'=HYPERLINK("{post_url}","{raw}")' if post_url else raw

    if key in ("original_url", "png_url", "svg_url"):
        filename_keys = {
            "original_url": "original_filename",
            "png_url":       "png_filename",
            "svg_url":       "svg_filename",
        }
        label = row.get(filename_keys[key], "")
        if not label:
            # Fallback: derive from title
            title = row.get("title", "")
            suffixes = {"original_url": ".png", "png_url": "-final.png", "svg_url": "-editable.svg"}
            label = f"{title}{suffixes[key]}" if title else raw
        return f'=HYPERLINK("{raw}","{label}")'

    return raw


def append_row(sheet_id: str, row: dict) -> None:
    sa_json = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    if not sa_json:
        raise RuntimeError("GOOGLE_SERVICE_ACCOUNT_JSON not in environment")

    creds = Credentials.from_service_account_info(
        json.loads(sa_json), scopes=SCOPES
    )
    service = build("sheets", "v4", credentials=creds)
    ss = service.spreadsheets()

    # Read header row to determine column order
    header_range = f"{TAB}!{HEADER_ROW}:{HEADER_ROW}"
    result = ss.values().get(spreadsheetId=sheet_id, range=header_range).execute()
    headers: list[str] = result.get("values", [[]])[0]

    if not headers:
        raise RuntimeError(f"Header row is empty — check the '{TAB}' tab exists")

    # Build the row in column order
    values = []
    for header in headers:
        key = _resolve_key(header)
        values.append(_cell_value(key, row) if key else "")

    append_range = f"{TAB}!A:{_col_letter(len(headers))}"
    ss.values().append(
        spreadsheetId=sheet_id,
        range=append_range,
        valueInputOption="USER_ENTERED",
        insertDataOption="INSERT_ROWS",
        body={"values": [values]},
    ).execute()


def _col_letter(n: int) -> str:
    """Convert 1-based column number to letter(s), e.g. 1→A, 27→AA."""
    result = ""
    while n:
        n, rem = divmod(n - 1, 26)
        result = chr(65 + rem) + result
    return result


def main() -> int:
    if len(sys.argv) != 3:
        print("Usage: append_sheet_row.py <sheet_id> '<row_json>'", file=sys.stderr)
        return 1
    sheet_id = sys.argv[1]
    row = json.loads(sys.argv[2])
    append_row(sheet_id, row)
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
