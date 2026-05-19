#!/usr/bin/env tsx
// Run: doppler run -- tsx automations/free-member-sync/skool-sync.ts
import { loadEnv } from '../shared/env.js';
import { createLogger } from '../shared/logger.js';
import { SkoolClient } from '../shared/skool/skool-client.js';
import { MembersSheet } from './members-sheet.js';

const GROUP = 'career-systems';
const log = createLogger('skool-sync');

async function main(): Promise<void> {
  const env = loadEnv([
    'SKOOL_EMAIL',
    'SKOOL_PASSWORD',
    'GOOGLE_SERVICE_ACCOUNT_JSON',
    'SKOOL_FREE_MEMBER_SYNC_SHEET_ID',
  ]);

  const skool = new SkoolClient({ email: env.SKOOL_EMAIL, password: env.SKOOL_PASSWORD });
  const sheets = new MembersSheet(
    env.GOOGLE_SERVICE_ACCOUNT_JSON,
    env.SKOOL_FREE_MEMBER_SYNC_SHEET_ID,
  );
  const timestamp = new Date().toISOString();

  try {
    await skool.ensureSession(GROUP);
    log.info('session ready');

    log.info('fetching members');
    const members = await skool.fetchAllMembers({ group: GROUP, log });
    log.info({ count: members.length }, 'members fetched');

    log.info('upserting into Google Sheets');
    const result = await sheets.upsertMembers(members);
    log.info({ inserted: result.inserted, updated: result.updated }, 'upsert complete');

    await sheets.appendSyncLog({
      timestamp,
      event: 'skool-sync',
      status: 'success',
      detail: `${members.length} members fetched; ${result.inserted} inserted, ${result.updated} updated`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'sync failed');
    await sheets.appendSyncLog({
      timestamp,
      event: 'skool-sync',
      status: 'error',
      detail: message,
    });
    process.exit(1);
  } finally {
    await skool.close();
  }
}

main();
