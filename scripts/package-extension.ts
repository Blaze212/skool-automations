#!/usr/bin/env tsx
// Build, zip, and upload the LinkedIn Tracker Chrome extension to Supabase Storage.
// Run: doppler run -- pnpm package:extension

import { execSync } from 'node:child_process';
import { createReadStream, existsSync, rmSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const BUCKET = 'Tracker-Extensions';
const STORAGE_PATH = 'chrome/career-systems-plugin.zip';
const ZIP_PATH = 'linkedin-tracker/career-systems-plugin.zip';

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — run via doppler run --');
  process.exit(1);
}

console.log('Building extension...');
execSync('pnpm build:extension', { stdio: 'inherit' });

if (existsSync(ZIP_PATH)) rmSync(ZIP_PATH);

const gitHash = execSync('git rev-parse HEAD').toString().trim();
const builtAt = new Date().toISOString();
const buildInfo = JSON.stringify({ gitHash, builtAt }, null, 2);
execSync(`echo '${buildInfo}' > linkedin-tracker/dist/build-info.json`);
console.log(`Build info: ${gitHash} @ ${builtAt}`);

console.log('Zipping dist/...');
execSync(`cd linkedin-tracker && zip -r career-systems-plugin.zip dist/`, { stdio: 'inherit' });

console.log(`Uploading to ${BUCKET}/${STORAGE_PATH}...`);
const supabase = createClient(supabaseUrl, serviceRoleKey);
const fileStream = createReadStream(ZIP_PATH);

const { error } = await supabase.storage.from(BUCKET).upload(STORAGE_PATH, fileStream, {
  contentType: 'application/zip',
  upsert: true,
});

if (error) {
  console.error('Upload failed:', error.message);
  process.exit(1);
}

const { data } = supabase.storage.from(BUCKET).getPublicUrl(STORAGE_PATH);
console.log('Done.');
console.log('Public URL:', data.publicUrl);
