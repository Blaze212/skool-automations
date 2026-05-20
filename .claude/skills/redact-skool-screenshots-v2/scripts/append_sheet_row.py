#!/usr/bin/env python3
"""
Append one proof log row to the Overview sheet.

Usage:
    python3 append_sheet_row.py <sheet_id> '<row_json>'

row_json is a JSON object with these keys (all strings):
    date, area, level, function, status, main_objection,
    trigger, behavior, outcome, friction_surprise, artifact_candidate,
    png_url, svg_url

Reads GOOGLE_SERVICE_ACCOUNT_JSON from the environment.
Appends to Overview!A:M with hyperlinks in the PNG and SVG columns.
Prints "OK" to stdout on success.
"""
from __future__ import annotations

import json
import os
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


SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
RANGE  = "Overview!A:P"


def append_row(sheet_id: str, row: dict) -> None:
    sa_json = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    if not sa_json:
        raise RuntimeError("GOOGLE_SERVICE_ACCOUNT_JSON not in environment")

    creds = Credentials.from_service_account_info(
        json.loads(sa_json), scopes=SCOPES
    )
    service = build("sheets", "v4", credentials=creds)

    post_url = row.get("post_url", "")
    date_str = row.get("date", "")
    date_cell = f'=HYPERLINK("{post_url}","{date_str}")' if post_url else date_str

    original_formula = f'=HYPERLINK("{row["original_url"]}","View Original")'
    png_formula = f'=HYPERLINK("{row["png_url"]}","View PNG")'
    svg_formula = f'=HYPERLINK("{row["svg_url"]}","View SVG")'

    values = [[
        date_cell,
        row.get("title", ""),
        row.get("area", ""),
        row.get("level", ""),
        row.get("function", ""),
        row.get("status", ""),
        row.get("main_objection", ""),
        row.get("trigger", ""),
        row.get("behavior", ""),
        row.get("outcome", ""),
        row.get("friction_surprise", ""),
        row.get("artifact_candidate", ""),
        row.get("post_text", ""),
        original_formula,
        png_formula,
        svg_formula,
    ]]

    service.spreadsheets().values().append(
        spreadsheetId=sheet_id,
        range=RANGE,
        valueInputOption="USER_ENTERED",
        insertDataOption="INSERT_ROWS",
        body={"values": values},
    ).execute()


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
