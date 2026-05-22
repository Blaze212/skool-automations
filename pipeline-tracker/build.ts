import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readdirSync } from 'fs';

const WEBHOOK_URL = process.env.PIPELINE_TRACKER_WEBHOOK_URL ?? '';
if (!WEBHOOK_URL) {
  console.warn(
    '[build] WARNING: PIPELINE_TRACKER_WEBHOOK_URL is not set — background.js will not POST events.\n' +
      '  Set it before building: PIPELINE_TRACKER_WEBHOOK_URL=https://... pnpm build:pipeline-tracker',
  );
}

mkdirSync('pipeline-tracker/dist/popup', { recursive: true });
mkdirSync('pipeline-tracker/dist/icons', { recursive: true });

await esbuild.build({
  entryPoints: ['pipeline-tracker/src/content.ts'],
  bundle: true,
  format: 'iife',
  outfile: 'pipeline-tracker/dist/content.js',
  define: {
    PIPELINE_TRACKER_WEBHOOK_URL: JSON.stringify(WEBHOOK_URL),
  },
});

await esbuild.build({
  entryPoints: ['pipeline-tracker/src/background.ts'],
  bundle: true,
  format: 'esm',
  outfile: 'pipeline-tracker/dist/background.js',
  define: {
    PIPELINE_TRACKER_WEBHOOK_URL: JSON.stringify(WEBHOOK_URL),
  },
});

await esbuild.build({
  entryPoints: ['pipeline-tracker/src/popup/popup.ts'],
  bundle: true,
  format: 'iife',
  outfile: 'pipeline-tracker/dist/popup/popup.js',
  define: {
    PIPELINE_TRACKER_WEBHOOK_URL: JSON.stringify(WEBHOOK_URL),
  },
});

copyFileSync('pipeline-tracker/src/manifest.json', 'pipeline-tracker/dist/manifest.json');
copyFileSync('pipeline-tracker/src/popup/popup.html', 'pipeline-tracker/dist/popup/popup.html');

for (const file of readdirSync('pipeline-tracker/src/icons')) {
  copyFileSync(`pipeline-tracker/src/icons/${file}`, `pipeline-tracker/dist/icons/${file}`);
}

console.log('Pipeline Tracker build complete');
