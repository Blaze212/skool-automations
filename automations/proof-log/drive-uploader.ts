/**
 * Upload a redacted PNG to the proof-log Google Drive folder.
 *
 * Usage: tsx automations/proof-log/drive-uploader.ts <file-path>
 * Prints the Drive webViewLink to stdout on success.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DriveClient } from '../shared/google/drive-client.js';
import { readConfig } from './config.js';

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: drive-uploader.ts <file-path>');
    process.exit(1);
  }

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) {
    console.error('GOOGLE_SERVICE_ACCOUNT_JSON env var is required (inject via doppler run --)');
    process.exit(1);
  }

  const config = readConfig();
  const client = new DriveClient(serviceAccountJson);

  const fileName = path.basename(filePath);
  const content = fs.readFileSync(filePath);

  const result = await client.uploadFile({
    name: fileName,
    folderId: config.driveFolderId,
    mimeType: 'image/png',
    content,
  });

  console.log(result.webViewLink);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
