#!/usr/bin/env tsx
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { loadEnv } from '../shared/env.js';
import { DriveClient } from '../shared/google/drive-client.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

export type Subfolder = 'original' | 'redacted' | 'final';

const POSTFIXES: Record<Subfolder, string> = {
  original: '',
  redacted: '-redacted',
  final: '-final',
};

export function applyPostfix(filePath: string, subfolder: Subfolder): string {
  const ext = extname(filePath);
  const base = basename(filePath, ext);
  return base + POSTFIXES[subfolder] + ext;
}

export function detectMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const mime = MIME_TYPES[ext];
  if (!mime) throw new Error(`Unsupported file extension: ${ext}`);
  return mime;
}

async function findOrCreateFolder(
  drive: DriveClient,
  parentId: string,
  name: string,
): Promise<string> {
  const files = await drive.listFiles({ folderId: parentId, mimeType: FOLDER_MIME });
  const existing = files.find((f) => f.name === name);
  if (existing) return existing.id;
  return drive.createFolder({ name, parentId });
}

async function main(): Promise<void> {
  const [filePath, subfolder] = process.argv.slice(2);

  if (!filePath || !subfolder) {
    process.stderr.write('Usage: tsx drive-uploader.ts <file-path> <original|redacted|final>\n');
    process.exit(1);
  }

  if (!['original', 'redacted', 'final'].includes(subfolder)) {
    process.stderr.write(`Invalid subfolder: ${subfolder}. Must be original, redacted, or final\n`);
    process.exit(1);
  }

  try {
    const env = loadEnv(['GOOGLE_SERVICE_ACCOUNT_JSON', 'PROOF_LOG_DRIVE_FOLDER_ID']);
    const drive = new DriveClient(env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const mimeType = detectMimeType(filePath);
    const content = readFileSync(filePath);
    const name = applyPostfix(filePath, subfolder as Subfolder);

    const subFolderId = await findOrCreateFolder(drive, env.PROOF_LOG_DRIVE_FOLDER_ID, subfolder);

    const result = await drive.uploadFile({ name, folderId: subFolderId, mimeType, content });
    process.stdout.write(result.webViewLink + '\n');
  } catch (err) {
    process.stderr.write((err instanceof Error ? err.message : String(err)) + '\n');
    process.exit(1);
  }
}

const runningDirectly =
  typeof process !== 'undefined' &&
  process.argv[1] != null &&
  (process.argv[1].endsWith('drive-uploader.ts') || process.argv[1].endsWith('drive-uploader.js'));

if (runningDirectly) {
  main();
}
