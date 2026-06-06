// Spec 012 Phase 11 — CSV export (D7).
//
// Columns: captured_at, name, title, profile_url, event_type, message_text,
//          source, recovered_html.
//
// D-rev-28: recovered_html is read from the per-id keyed store at export time;
//           it is never inlined on OutboxEntry. Callers pre-fetch and pass a
//           map so this module stays pure (no direct storage access).
// D-rev-30: recovered_html column is empty unless source === 'ai-recovered'.
//           message_text column is empty when capture_message_bodies is false.

import type { OutboxEntry } from './types.ts';

export const CSV_HEADERS = [
  'captured_at',
  'name',
  'title',
  'profile_url',
  'event_type',
  'message_text',
  'source',
  'recovered_html',
] as const;

/**
 * RFC 4180 CSV cell escaping.
 * Wraps in double-quotes iff the value contains a comma, double-quote,
 * carriage return, or newline. Inner double-quotes are doubled.
 */
export function escapeCell(value: string): string {
  if (value.includes('"') || value.includes(',') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Build a complete CSV string from the outbox.
 *
 * @param outbox  - current outbox snapshot (capture order)
 * @param recoveredHtml - map of history_id → HTML string (or null/absent)
 * @param captureMessageBodies - if false, message_text column is empty
 */
export function buildCsv(
  outbox: OutboxEntry[],
  recoveredHtml: Record<string, string | null>,
  captureMessageBodies: boolean,
): string {
  const lines: string[] = [CSV_HEADERS.join(',')];
  for (const entry of outbox) {
    const ev = entry.event;
    const source = ev.source ?? 'selectors';
    const html = source === 'ai-recovered' ? (recoveredHtml[entry.history_id] ?? '') : '';
    lines.push(
      [
        escapeCell(entry.enqueued_at),
        escapeCell(ev.name),
        escapeCell(ev.title),
        escapeCell(ev.profile_url),
        escapeCell(ev.event_type),
        escapeCell(captureMessageBodies ? (ev.message_text ?? '') : ''),
        escapeCell(source),
        escapeCell(html),
      ].join(','),
    );
  }
  return lines.join('\n');
}

/**
 * Returns the download filename for the given date, e.g.
 * `pipeline-2026-05-31.csv`.
 */
export function getCsvFilename(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `pipeline-${y}-${m}-${d}.csv`;
}
