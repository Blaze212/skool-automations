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
import * as path from 'path';

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
} else {
  mkdirSync(`${distDir}/sidepanel`, { recursive: true });
}

const define = {
  PIPELINE_TRACKER_WEBHOOK_URL: JSON.stringify(WEBHOOK_URL),
  BUILD_TARGET: JSON.stringify(target),
};

// Rewrite imports of `./destination-impl.ts` to the per-target factory file.
// This is the load-bearing mechanism that keeps the webhook code out of the
// publishable bundle: destination-impl.publishable.ts only imports
// destination-appsync.ts, so destination-webhook.ts (and the lone `fetch(`
// in the codebase) is never reachable from the publishable graph. The default
// re-export in destination-impl.ts targets the internal factory so vitest /
// tsc / any unbundled tool path keeps working without this plugin.
const destinationImplPlugin: esbuild.Plugin = {
  name: 'destination-impl-target',
  setup(build) {
    build.onResolve({ filter: /(^|\/)destination-impl\.ts$/ }, (args) => {
      const replacement =
        target === 'internal' ? 'destination-impl.internal.ts' : 'destination-impl.publishable.ts';
      return { path: path.resolve(args.resolveDir, replacement) };
    });
  },
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
  plugins: [destinationImplPlugin],
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
} else {
  await esbuild.build({
    entryPoints: ['pipeline-tracker/src/sidepanel/sidepanel.ts'],
    bundle: true,
    format: 'iife',
    outfile: `${distDir}/sidepanel/sidepanel.js`,
    define,
  });
  copyFileSync('pipeline-tracker/src/sidepanel/index.html', `${distDir}/sidepanel/index.html`);
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
