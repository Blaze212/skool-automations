#!/usr/bin/env tsx
// Run: doppler run -- pnpm tsx scripts/pull-kit-sequences.ts
// Writes one markdown file per sequence to docs/kit-sequences/

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const OUT_DIR = join(REPO_ROOT, 'docs', 'kit-sequences');
const BASE = 'https://api.kit.com/v4';

const KEY = process.env.KIT_V4_API_KEY;
if (!KEY) {
  console.error(
    'KIT_V4_API_KEY not set — run via: doppler run -- pnpm tsx scripts/pull-kit-sequences.ts',
  );
  process.exit(1);
}

const headers = { 'X-Kit-Api-Key': KEY };

interface Sequence {
  id: number;
  name: string;
  active: boolean;
  repeat: boolean;
  hold: boolean;
}

interface SequenceEmail {
  id: number;
  position: number;
  subject: string;
  preview_text: string | null;
  content: string | null;
  delay_value: number;
  delay_unit: string;
  send_days: string[];
  published: boolean;
  email_template_id: number | null;
}

async function fetchAllPages<T>(url: string): Promise<T[]> {
  const results: T[] = [];
  let cursor: string | null = null;

  do {
    const paged = cursor ? `${url}${url.includes('?') ? '&' : '?'}after=${cursor}` : url;
    const res = await fetch(paged, { headers });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${paged}`);
    const body = (await res.json()) as {
      pagination?: { end_cursor?: string; has_next_page?: boolean };
    } & Record<string, T[]>;

    const key = Object.keys(body).find((k) => Array.isArray(body[k]));
    if (key) results.push(...body[key]);

    cursor = body.pagination?.has_next_page ? (body.pagination.end_cursor ?? null) : null;
  } while (cursor);

  return results;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function formatDelay(value: number, unit: string): string {
  return `${value} ${unit}${value !== 1 ? 's' : ''}`;
}

function renderEmail(email: SequenceEmail, index: number): string {
  const lines: string[] = [];
  lines.push(`## Email ${index + 1}: ${email.subject}`);
  lines.push('');

  const meta: string[] = [];
  meta.push(`**Delay:** ${formatDelay(email.delay_value, email.delay_unit)} after previous`);
  if (email.send_days.length > 0) meta.push(`**Send days:** ${email.send_days.join(', ')}`);
  meta.push(`**Published:** ${email.published ? 'Yes' : 'No'}`);
  if (email.preview_text) meta.push(`**Preview:** ${email.preview_text}`);
  lines.push(meta.join(' · '));
  lines.push('');

  if (email.content) {
    lines.push('### Content');
    lines.push('');
    lines.push(email.content.trim());
  } else {
    lines.push('_No content returned_');
  }

  lines.push('');
  lines.push('---');
  lines.push('');
  return lines.join('\n');
}

function renderSequence(seq: Sequence, emails: SequenceEmail[]): string {
  const lines: string[] = [];
  lines.push(`# ${seq.name}`);
  lines.push('');

  const meta = [
    `**Active:** ${seq.active ? 'Yes' : 'No'}`,
    `**Repeat:** ${seq.repeat ? 'Yes' : 'No'}`,
    `**Hold:** ${seq.hold ? 'Yes' : 'No'}`,
    `**Emails:** ${emails.length}`,
  ];
  lines.push(meta.join(' · '));
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const [i, email] of emails.entries()) {
    lines.push(renderEmail(email, i));
  }

  return lines.join('\n');
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  console.log('Fetching sequences...');
  const sequences = await fetchAllPages<Sequence>(`${BASE}/sequences`);
  console.log(`Found ${sequences.length} sequence(s)`);

  for (const seq of sequences) {
    process.stdout.write(`  Pulling "${seq.name}" (id=${seq.id})... `);

    const emails = await fetchAllPages<SequenceEmail>(
      `${BASE}/sequences/${seq.id}/emails?include_content=true&per_page=1000`,
    );

    const md = renderSequence(seq, emails);
    const filename = `${slugify(seq.name)}.md`;
    writeFileSync(join(OUT_DIR, filename), md);

    console.log(`${emails.length} emails → docs/kit-sequences/${filename}`);
  }

  console.log(`\nDone. Files written to docs/kit-sequences/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
