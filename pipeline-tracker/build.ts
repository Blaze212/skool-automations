// Spec 015 C7 — single unified build for the Pipeline Tracker extension.
//
// Usage:
//   tsx pipeline-tracker/build.ts   → dist/
//
// The internal/publishable BUILD_TARGET split (spec 012 Phase 4) is retired:
// internal pipeline behavior is now server-side via tracker_clients.sheet_layout,
// so there is one Chrome Web Store-publishable build. It has no webhook host
// permission and no popup; events sit in the outbox until app.cmcareersystems.com
// pulls them over externally_connectable (binding handshake + sync-pull/ack).

import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readdirSync } from 'fs';

const distDir = 'pipeline-tracker/dist';

mkdirSync(`${distDir}/icons`, { recursive: true });
mkdirSync(`${distDir}/sidepanel`, { recursive: true });

await esbuild.build({
  entryPoints: ['pipeline-tracker/src/content.ts'],
  bundle: true,
  format: 'iife',
  outfile: `${distDir}/content.js`,
});

await esbuild.build({
  entryPoints: ['pipeline-tracker/src/background.ts'],
  bundle: true,
  format: 'esm',
  outfile: `${distDir}/background.js`,
});

await esbuild.build({
  entryPoints: ['pipeline-tracker/src/sidepanel/sidepanel.ts'],
  bundle: true,
  format: 'iife',
  outfile: `${distDir}/sidepanel/sidepanel.js`,
});
copyFileSync('pipeline-tracker/src/sidepanel/index.html', `${distDir}/sidepanel/index.html`);

copyFileSync('pipeline-tracker/src/manifest.json', `${distDir}/manifest.json`);

for (const file of readdirSync('pipeline-tracker/src/icons')) {
  copyFileSync(`pipeline-tracker/src/icons/${file}`, `${distDir}/icons/${file}`);
}

console.log(`Pipeline Tracker build complete → ${distDir}/`);
