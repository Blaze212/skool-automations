#!/usr/bin/env tsx
// pnpm test:backfill-skool-ids   (JSON summary → logs/scriptout.log, pino logs → stderr)
import pino from 'pino';
import { loadEnv } from '../../shared/env.js';
import { SkoolClient } from '../../shared/skool/skool-client.js';
import { MembersSheet } from '../members-sheet.js';

const GROUP = 'career-systems';
const env = loadEnv([
  'SKOOL_EMAIL',
  'SKOOL_PASSWORD',
  'GOOGLE_SERVICE_ACCOUNT_JSON',
  'SKOOL_FREE_MEMBER_SYNC_SHEET_ID',
]);
const log = pino({ name: 'backfill-skool-ids', level: 'debug' }, pino.destination(process.stderr));
const skool = new SkoolClient({ email: env.SKOOL_EMAIL, password: env.SKOOL_PASSWORD });
const sheets = new MembersSheet(
  env.GOOGLE_SERVICE_ACCOUNT_JSON,
  env.SKOOL_FREE_MEMBER_SYNC_SHEET_ID,
);

try {
  log.info({ group: GROUP }, 'ensuring session');
  await skool.ensureSession(GROUP);
  log.info('session ready');

  log.info('listing all Skool members (user path)');
  const members = await skool.getMembersAsUser({ group: GROUP, log });
  log.info({ count: members.length }, 'members fetched');

  log.info('upserting into sheet — name-match fallback fills missing Skool IDs');
  const result = await sheets.upsertMembers(members, log);
  log.info(result, 'upsert complete');

  console.log(JSON.stringify(result, null, 2));
} finally {
  await skool.close();
}
