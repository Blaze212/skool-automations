#!/usr/bin/env python3
"""
Extract proof log fields from post text using Claude Haiku.

Usage:
    python3 extract_proof_data.py '<post text>'

Reads ANTHROPIC_API_KEY from the environment.
Prints a JSON object to stdout. Exit code 1 on failure.
"""
from __future__ import annotations

import json
import os
import sys

try:
    import anthropic
except ImportError:
    import subprocess
    subprocess.check_call(
        [sys.executable, "-m", "pip", "install", "anthropic",
         "--break-system-packages", "-q"]
    )
    import anthropic

SYSTEM_PROMPT = """You are a proof log extraction assistant for a career advisory practice called Career Systems.

Given the text of a Skool community win post, extract proof log data and return it as a JSON object.

Fields to extract:
- area: classify as exactly one of: Resume, Outreach, Interview, Negotiation, Mindset
- level: the poster's career level — one of: IC, Manager, Director, VP, Fractional
- function: the poster's job function — one of: Product, Ops, HR, Marketing, Finance, Sales, Engineering, Legal, Other
- status: the poster's employment status — one of: Laid off, Employed, Fractional pivot
- main_objection: the fear or objection this win disproves — one of:
    Price, Time, I should know this already, Too introverted, My case is different
- trigger: what changed or what prompted the action (1–2 sentences, past tense)
- behavior: what the person specifically did (1–2 sentences, past tense)
- outcome: the measurable result — quote numbers directly from the post where present (1–2 sentences)
- friction_surprise: what was unexpected, hard, or surprising (1–2 sentences)
- artifact_candidate: what from this story could be reused as a template, framework, or social proof asset

Rules:
- Return ONLY a valid JSON object — no markdown, no commentary, no code fences
- Use the exact field names listed above
- Use "Unknown" only when a field genuinely cannot be inferred from the post text
- Never fabricate details not present in the post"""


def extract(post_text: str) -> dict:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY not in environment")

    client = anthropic.Anthropic(api_key=api_key)
    message = client.messages.create(
        model="claude-haiku-4-5",
        max_tokens=1024,
        system=SYSTEM_PROMPT,
        messages=[
            {
                "role": "user",
                "content": f"Extract proof log data from this post:\n\n{post_text}",
            }
        ],
    )
    raw = message.content[0].text.strip()
    # Strip markdown code fences if the model wrapped the JSON anyway
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    return json.loads(raw.strip())


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: extract_proof_data.py '<post text>'", file=sys.stderr)
        return 1
    post_text = sys.argv[1]
    try:
        data = extract(post_text)
        print(json.dumps(data))
        return 0
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
