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
- main_objection: the single fear or belief this win disproves — one of:
    Price, Time, I should know this already, Too introverted, My case is different
- trigger: what changed or what forced action. Include: the inciting event (e.g. layoff, stalled process), how long they waited or struggled before acting, and what finally prompted them to start. Write 1–2 sentences in past tense.
- behavior: the specific actions taken, in sequence if multiple. Include: what method they used, how many touchpoints or messages, what they said or asked for, and any notable constraint (e.g. did NOT ask for a job directly). Write 1–2 sentences in past tense.
- outcome: the measurable result. Quote exact numbers from the post where present (interviews landed, response rates, comp delta, rounds advanced). Include any secondary outcome such as a mindset shift or unexpected signal of strong fit. Write 1–2 sentences in past tense.
- friction_surprise: two distinct elements — (1) the friction: what made this hard, scary, or emotionally costly before or during the action; (2) the surprise: what worked better or differently than expected, or what the result revealed. Write 1–2 sentences covering both.
- artifact_candidate: identify 1–2 reusable assets this story could generate. For each, name the asset type (template, SOP, checklist, framework, outline) and describe it specifically — what it would contain or teach. Format as a short bulleted list.

Rules:
- Return ONLY a valid JSON object — no markdown, no commentary, no code fences
- Use the exact field names listed above
- artifact_candidate should be a JSON array of strings, one per asset
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
