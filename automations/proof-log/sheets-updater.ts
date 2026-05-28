/**
 * Append a proof-log entry to the tracking Google Sheet.
 *
 * Usage: tsx automations/proof-log/sheets-updater.ts <source-file-path> <drive-url> [notes]
 * Appends one row: [ISO date, filename, drive-url, notes]
 */

import path from 'node:path';
import { SheetsClient } from '../shared/google/sheets-client.js';
import { readConfig } from './config.js';

const SHEET_RANGE = 'Overview!A:D';

async function main() {
  const [, , filePath, driveUrl, notes = ''] = process.argv;
  if (!filePath || !driveUrl) {
    console.error('Usage: sheets-updater.ts <source-file-path> <drive-url> [notes]');
    process.exit(1);
  }

  const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) {
    console.error('GOOGLE_SERVICE_ACCOUNT_JSON env var is required (inject via doppler run --)');
    process.exit(1);
  }

  const config = readConfig();
  const client = new SheetsClient(serviceAccountJson, config.sheetId);

  const date = new Date().toISOString().slice(0, 10);
  const fileName = path.basename(filePath);

  await client.appendRows(SHEET_RANGE, [[date, fileName, driveUrl, notes]]);
  console.log(`Logged: ${date} | ${fileName} | ${driveUrl}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
