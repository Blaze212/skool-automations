#!/usr/bin/env tsx
import { loadEnv } from '../shared/env.js';
import type { ProofLogRow } from './proof-log-sheet.js';
import { ProofLogSheet } from './proof-log-sheet.js';

const REQUIRED_FIELDS: (keyof ProofLogRow)[] = [
  'date',
  'screenshotLink',
  'area',
  'level',
  'function',
  'status',
];

function validate(data: unknown): ProofLogRow {
  if (!data || typeof data !== 'object') throw new Error('JSON must be an object');
  const row = data as Record<string, unknown>;
  for (const field of REQUIRED_FIELDS) {
    if (typeof row[field] !== 'string') {
      throw new Error(`Missing or invalid required field: ${field}`);
    }
  }
  return {
    date: (row.date as string) ?? '',
    screenshotLink: (row.screenshotLink as string) ?? '',
    redactedLink: (row.redactedLink as string) ?? '',
    svgLink: (row.svgLink as string) ?? '',
    area: (row.area as string) ?? '',
    level: (row.level as string) ?? '',
    function: (row.function as string) ?? '',
    status: (row.status as string) ?? '',
    trigger: (row.trigger as string) ?? '',
    behavior: (row.behavior as string) ?? '',
    outcome: (row.outcome as string) ?? '',
    friction: (row.friction as string) ?? '',
    artifacts: (row.artifacts as string) ?? '',
    mainObjection: (row.mainObjection as string) ?? '',
  };
}

async function main(): Promise<void> {
  const [jsonArg] = process.argv.slice(2);

  if (!jsonArg) {
    process.stderr.write("Usage: tsx sheets-updater.ts '<json-string>'\n");
    process.exit(1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonArg);
  } catch {
    process.stderr.write('Invalid JSON argument\n');
    process.exit(1);
  }

  let row: ProofLogRow;
  try {
    row = validate(parsed);
  } catch (err) {
    process.stderr.write((err instanceof Error ? err.message : String(err)) + '\n');
    process.exit(1);
  }

  try {
    const env = loadEnv(['GOOGLE_SERVICE_ACCOUNT_JSON', 'PROOF_LOG_SHEET_ID']);
    const sheet = new ProofLogSheet(env.GOOGLE_SERVICE_ACCOUNT_JSON, env.PROOF_LOG_SHEET_ID);
    await sheet.insertRowAtTop(row);
  } catch (err) {
    process.stderr.write((err instanceof Error ? err.message : String(err)) + '\n');
    process.exit(1);
  }
}

main();
