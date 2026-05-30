// Spec 012 Phase 4 — two-target build for the pipeline tracker extension.
//
// Usage:
//   tsx pipeline-tracker/build.ts --target=internal      → dist-internal/
//   tsx pipeline-tracker/build.ts --target=publishable   → dist-publishable/
//   tsx pipeline-tracker/build.ts                        → defaults to internal
//
// Internal build: behavior-identical to pre-Phase-4 main. Popup UI,
// `pipeline-tracker-webhook` destination, alarms-based keep-alive drain.
//
// Publishable build: Chrome Web Store target. No webhook host permission,
// no popup, no autonomous drain. The DestinationStrategy module dead-codes
// the webhook fetch via the BUILD_TARGET define, and a separate CI guard
// (`guard:no-fetch-in-publishable`) greps the bundled background.js to make
// sure no `fetch(`/`XMLHttpRequest` slips through.

import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readdirSync } from 'fs';

type Target = 'internal' | 'publishable';

function parseTarget(argv: string[]): Target {
  const arg = argv.find((a) => a.startsWith('--target='));
  if (!arg) return 'internal';
  const value = arg.slice('--target='.length);
  if (value !== 'internal' && value !== 'publishable') {
    throw new Error(`Unknown --target=${value}; expected "internal" or "publishable"`);
  }
  return value;
}

const target: Target = parseTarget(process.argv.slice(2));

// The internal build still consumes Doppler-injected secrets at module load.
// The publishable build deliberately leaves the webhook URL undefined so any
// accidental reference at runtime fails loud, and so the bundled string never
// leaks the internal endpoint to Web Store users.
const WEBHOOK_URL =
  target === 'internal'
    ? (process.env.PIPELINE_TRACKER_WEBHOOK_URL ??
      'https://ktazhzplyhpqayjaghur.supabase.co/functions/v1/pipeline-tracker-webhook')
    : '';

const distDir =
  target === 'internal' ? 'pipeline-tracker/dist-internal' : 'pipeline-tracker/dist-publishable';

mkdirSync(`${distDir}/icons`, { recursive: true });
if (target === 'internal') {
  mkdirSync(`${distDir}/popup`, { recursive: true });
}

const define = {
  PIPELINE_TRACKER_WEBHOOK_URL: JSON.stringify(WEBHOOK_URL),
  BUILD_TARGET: JSON.stringify(target),
};

await esbuild.build({
  entryPoints: ['pipeline-tracker/src/content.ts'],
  bundle: true,
  format: 'iife',
  outfile: `${distDir}/content.js`,
  define,
});

await esbuild.build({
  entryPoints: ['pipeline-tracker/src/background.ts'],
  bundle: true,
  format: 'esm',
  outfile: `${distDir}/background.js`,
  define,
  // minifySyntax collapses `if (BUILD_TARGET === 'publishable')` branches at
  // build time so the publishable bundle never contains webhook fetch code.
  // Without this, esbuild keeps the dead branch and the CI guard #3 grep would
  // trip on the residual fetch(...) call.
  minifySyntax: target === 'publishable',
});

if (target === 'internal') {
  await esbuild.build({
    entryPoints: ['pipeline-tracker/src/popup/popup.ts'],
    bundle: true,
    format: 'iife',
    outfile: `${distDir}/popup/popup.js`,
    define,
  });
  copyFileSync('pipeline-tracker/src/popup/popup.html', `${distDir}/popup/popup.html`);
}

copyFileSync(
  target === 'internal'
    ? 'pipeline-tracker/src/manifest.internal.json'
    : 'pipeline-tracker/src/manifest.publishable.json',
  `${distDir}/manifest.json`,
);

for (const file of readdirSync('pipeline-tracker/src/icons')) {
  copyFileSync(`pipeline-tracker/src/icons/${file}`, `${distDir}/icons/${file}`);
}

console.log(`Pipeline Tracker build complete: ${target} → ${distDir}/`);
