#!/usr/bin/env tsx
/**
 * export-members-csv.ts
 *
 * Pulls every active member from a Skool community (admin-paginated path) and
 * writes a wide CSV: full_name, skool_id, then one column per unique onboarding
 * question. Members without onboarding answers are included with blank cells.
 *
 * Run: doppler run -- pnpm tsx scripts/export-members-csv.ts <group-slug> [--out path.csv]
 *
 * Requires SKOOL_EMAIL and SKOOL_PASSWORD (provided via Doppler).
 * The Skool account must be an admin of <group-slug>.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv } from '../automations/shared/env.js';
import { createLogger } from '../automations/shared/logger.js';
import { SkoolClient } from '../automations/shared/skool/skool-client.js';
import { parseFullSurvey } from '../automations/shared/skool/members-api.js';

const log = createLogger('export-members-csv');

interface ParsedArgs {
  group: string;
  outPath: string | undefined;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  let outPath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') {
      outPath = argv[++i];
    } else if (arg.startsWith('--out=')) {
      outPath = arg.slice('--out='.length);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length !== 1) {
    console.error(
      'Usage: doppler run -- pnpm tsx scripts/export-members-csv.ts <group-slug> [--out path.csv]',
    );
    process.exit(1);
  }

  return { group: positional[0], outPath };
}

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function csvRow(values: string[]): string {
  return values.map(csvEscape).join(',');
}

function defaultOutPath(group: string): string {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return join(process.cwd(), `members-${group}-${stamp}.csv`);
}

async function main(): Promise<void> {
  const { group, outPath } = parseArgs(process.argv.slice(2));
  const env = loadEnv(['SKOOL_EMAIL', 'SKOOL_PASSWORD']);

  const skool = new SkoolClient({ email: env.SKOOL_EMAIL, password: env.SKOOL_PASSWORD });

  try {
    await skool.ensureSession(group);
    log.info({ group }, 'session ready');

    log.info('fetching raw members (admin-paginated)');
    const raws = await skool.listRawMembersAsAdmin({ group, log });
    log.info({ count: raws.length }, 'members fetched');

    // First pass: collect the union of all question texts, preserving first-seen order.
    const questionsOrder: string[] = [];
    const seenQuestions = new Set<string>();
    const perMemberSurvey = new Map<string, Map<string, string>>();

    for (const raw of raws) {
      const survey = parseFullSurvey(raw.member.metadata?.survey);
      const answers = new Map<string, string>();
      for (const { question, answer } of survey) {
        if (!seenQuestions.has(question)) {
          seenQuestions.add(question);
          questionsOrder.push(question);
        }
        answers.set(question, answer);
      }
      perMemberSurvey.set(raw.id, answers);
    }

    // Second pass: emit rows.
    const header = ['full_name', 'skool_id', ...questionsOrder];
    const rows: string[] = [csvRow(header)];

    for (const raw of raws) {
      const fullName = `${raw.firstName ?? ''} ${raw.lastName ?? ''}`.trim();
      const answers = perMemberSurvey.get(raw.id) ?? new Map<string, string>();
      const cells = [fullName, raw.id, ...questionsOrder.map((q) => answers.get(q) ?? '')];
      rows.push(csvRow(cells));
    }

    const target = outPath ?? defaultOutPath(group);
    writeFileSync(target, rows.join('\n') + '\n', 'utf8');
    log.info(
      { path: target, members: raws.length, questions: questionsOrder.length },
      'csv written',
    );
    console.log(target);
  } finally {
    await skool.close();
  }
}

main().catch((err: Error) => {
  log.error({ err: err.message, stack: err.stack }, 'export failed');
  process.exit(1);
});
