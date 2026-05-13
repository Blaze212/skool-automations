import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'fs';

const WEBHOOK_URL = process.env.LINKEDIN_TRACKER_WEBHOOK_URL ?? '';
if (!WEBHOOK_URL) {
  console.warn(
    '[build] WARNING: LINKEDIN_TRACKER_WEBHOOK_URL is not set — background.js will not POST events.\n' +
      '  Set it before building: LINKEDIN_TRACKER_WEBHOOK_URL=https://... pnpm build:extension',
  );
}

mkdirSync('linkedin-tracker/dist/popup', { recursive: true });

await esbuild.build({
  entryPoints: ['linkedin-tracker/src/content.ts'],
  bundle: true,
  format: 'iife',
  outfile: 'linkedin-tracker/dist/content.js',
  define: {
    LINKEDIN_TRACKER_WEBHOOK_URL: JSON.stringify(WEBHOOK_URL),
  },
});

await esbuild.build({
  entryPoints: ['linkedin-tracker/src/background.ts'],
  bundle: true,
  format: 'esm',
  outfile: 'linkedin-tracker/dist/background.js',
  define: {
    LINKEDIN_TRACKER_WEBHOOK_URL: JSON.stringify(WEBHOOK_URL),
  },
});

await esbuild.build({
  entryPoints: ['linkedin-tracker/src/popup/popup.ts'],
  bundle: true,
  format: 'iife',
  outfile: 'linkedin-tracker/dist/popup/popup.js',
  define: {
    LINKEDIN_TRACKER_WEBHOOK_URL: JSON.stringify(WEBHOOK_URL),
  },
});

copyFileSync('linkedin-tracker/src/manifest.json', 'linkedin-tracker/dist/manifest.json');
copyFileSync('linkedin-tracker/src/popup/popup.html', 'linkedin-tracker/dist/popup/popup.html');

console.log('Extension build complete');
