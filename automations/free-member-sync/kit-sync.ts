#!/usr/bin/env tsx
// Run: doppler run -- tsx automations/free-member-sync/kit-sync.ts
import { loadEnv } from '../shared/env.js';
import { createLogger } from '../shared/logger.js';
import { MembersSheet } from './members-sheet.js';
import { KitClient } from './kit-client.js';
import type { HealthBucket } from './kit-client.js';

const log = createLogger('kit-sync');

function isHealthBucket(value: string): value is HealthBucket {
  return value === 'Red' || value === 'Yellow' || value === 'Green';
}

async function main(): Promise<void> {
  const env = loadEnv([
    'GOOGLE_SERVICE_ACCOUNT_JSON',
    'SKOOL_FREE_MEMBER_SYNC_SHEET_ID',
    'KIT_API_KEY',
  ]);
  const sheets = new MembersSheet(
    env.GOOGLE_SERVICE_ACCOUNT_JSON,
    env.SKOOL_FREE_MEMBER_SYNC_SHEET_ID,
  );
  const kit = new KitClient(env.KIT_API_KEY);
  const timestamp = new Date().toISOString();

  const headers = sheets.headers();
  const emailIdx = headers.indexOf('Email');
  const bucketIdx = headers.indexOf('Health Bucket');
  const purchaseIdx = headers.indexOf('Purchase/Scholarship');

  let synced = 0;
  let skipped = 0;
  let errors = 0;

  try {
    const members = await sheets.readAllMembers();
    log.info({ count: members.length }, 'members read from sheet');

    for (const row of members) {
      const email = row[emailIdx] ?? '';
      const bucketRaw = row[bucketIdx] ?? '';
      const purchased = (row[purchaseIdx] ?? '').trim().toUpperCase() === 'Y';

      if (!email) {
        skipped++;
        continue;
      }

      const bucket: HealthBucket | null = purchased
        ? null
        : isHealthBucket(bucketRaw)
          ? bucketRaw
          : null;

      if (!purchased && !isHealthBucket(bucketRaw)) {
        skipped++;
        continue;
      }

      try {
        await kit.syncSubscriberBucket(email, bucket);
        synced++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ email, err }, 'failed to sync subscriber');
        errors++;
      }
    }

    log.info({ synced, skipped, errors }, 'kit sync complete');

    await sheets.appendSyncLog({
      timestamp,
      event: 'kit-sync',
      status: errors > 0 ? 'warning' : 'success',
      detail: `${synced} synced, ${skipped} skipped, ${errors} errors`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'kit sync failed');
    await sheets.appendSyncLog({ timestamp, event: 'kit-sync', status: 'error', detail: message });
    process.exit(1);
  }

  if (errors > 0) process.exit(1);
}

main();
