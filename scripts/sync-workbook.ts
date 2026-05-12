#!/usr/bin/env tsx
/**
 * sync-workbook.ts
 *
 * Fetches the CareerSystems workbook from Google Docs, splits by heading,
 * embeds each section with Google text-embedding-004, and upserts into
 * Supabase public.workbook_chunks.
 *
 * Run:   doppler run -- pnpm tsx scripts/sync-workbook.ts
 * Debug: doppler run -- pnpm tsx scripts/sync-workbook.ts --debug
 *        (shows all paragraph styles found in the doc, skips DB write)
 *
 * Saves raw doc content to docs/workbook-raw.json for inspection.
 *
 * Legend during sync:
 *   +  new section embedded and inserted
 *   ~  changed section re-embedded and updated
 *   .  unchanged section skipped
 */

import { google } from 'googleapis';
import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEBUG = process.argv.includes('--debug');
const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..');

// Default URL only — the secret key is per-installation in newer Supabase CLI
// versions (format: sb_secret_...). Get yours with `supabase status`.
const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DocSection {
  headingId: string;
  title: string;
  content: string;
  anchorLink: string;
  tabPath: string;  // breadcrumb of tab titles, e.g. "Module 1 > Lessons"
}

// ---------------------------------------------------------------------------
// Parse Google Docs JSON into sections (handles tabs + nested child tabs)
// ---------------------------------------------------------------------------

// Styles treated as section headers
const HEADING_STYLES = new Set([
  'HEADING_1', 'HEADING_2', 'HEADING_3',
  'HEADING_4', 'HEADING_5', 'HEADING_6',
  'TITLE', 'SUBTITLE',
]);

function extractText(para: any): string {
  return (para.elements ?? [])
    .map((e: any) => e.textRun?.content ?? '')
    .join('')
    .replace(/\n$/, '')
    .trim();
}

function buildAnchorLink(docId: string, tabId: string | null, headingId: string): string {
  const base = `https://docs.google.com/document/d/${docId}/edit`;
  const heading = `#heading=${headingId}`;
  return tabId ? `${base}?tab=${tabId}${heading}` : `${base}${heading}`;
}

function parseTabBody(
  body: any,
  docId: string,
  tabId: string | null,
  tabPath: string,
  allStyles: Map<string, number>,
): DocSection[] {
  const sections: DocSection[] = [];
  let current: (Omit<DocSection, 'headingId' | 'anchorLink'> & {
    headingId: string | null;
    anchorLink: string | null;
  }) | null = null;

  for (const element of (body?.content ?? [])) {
    const para = element.paragraph;
    if (!para) continue;

    const style: string = para.paragraphStyle?.namedStyleType ?? 'NORMAL_TEXT';
    const text = extractText(para);
    if (!text) continue;

    allStyles.set(style, (allStyles.get(style) ?? 0) + 1);
    if (DEBUG) console.log(`[${tabPath || 'root'}] [${style}] ${text.slice(0, 80)}`);

    if (HEADING_STYLES.has(style)) {
      if (current?.content.trim() && current.headingId) {
        sections.push(current as DocSection);
      }
      const headingId: string | null = para.paragraphStyle?.headingId ?? null;
      current = {
        title: text,
        headingId,
        content: '',
        anchorLink: headingId ? buildAnchorLink(docId, tabId, headingId) : null,
        tabPath,
      };
    } else if (current) {
      current.content += (current.content ? '\n' : '') + text;
    }
  }

  if (current?.content.trim() && current.headingId) {
    sections.push(current as DocSection);
  }

  return sections;
}

function parseDocSections(doc: any, docId: string): DocSection[] {
  const sections: DocSection[] = [];
  const allStyles = new Map<string, number>();

  // Tabs API: when includeTabsContent=true, doc.tabs is populated and
  // doc.body is omitted. Walk tabs recursively (each can have childTabs).
  const walkTabs = (tabs: any[], parentPath: string) => {
    for (const tab of tabs ?? []) {
      const props = tab.tabProperties ?? {};
      const title = props.title ?? '(untitled tab)';
      const tabId = props.tabId ?? null;
      const path = parentPath ? `${parentPath} > ${title}` : title;

      if (tab.documentTab?.body) {
        sections.push(...parseTabBody(tab.documentTab.body, docId, tabId, path, allStyles));
      }
      if (tab.childTabs?.length) {
        walkTabs(tab.childTabs, path);
      }
    }
  };

  if (doc.tabs?.length) {
    walkTabs(doc.tabs, '');
  } else if (doc.body) {
    // Legacy single-body docs (no tabs)
    sections.push(...parseTabBody(doc.body, docId, null, '', allStyles));
  }

  // Always print style summary
  console.log('\nParagraph styles found in document:');
  for (const [style, count] of [...allStyles.entries()].sort((a, b) => b[1] - a[1])) {
    const marker = HEADING_STYLES.has(style) ? ' ← treated as heading' : '';
    console.log(`  ${style.padEnd(20)} ${count} paragraph(s)${marker}`);
  }
  console.log();

  return sections;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// Identifier stored alongside each chunk so we can detect model changes
// and force re-embedding when the model is swapped.
const EMBED_MODEL = 'Xenova/all-mpnet-base-v2';
const EMBED_DIMS = 768;

async function embedText(
  embedder: FeatureExtractionPipeline,
  text: string,
): Promise<number[]> {
  const output = await embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data as Float32Array);
}

async function main() {
  const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const docId = process.env.GOOGLE_DOC_WORKBOOK_ID;
  const supabaseUrl = process.env.SUPABASE_URL ?? LOCAL_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;

  if (!serviceAccountJson) { console.error('Missing: GOOGLE_SERVICE_ACCOUNT_JSON'); process.exit(1); }
  if (!docId) { console.error('Missing: GOOGLE_DOC_WORKBOOK_ID'); process.exit(1); }
  if (!supabaseKey) {
    console.error('Missing: SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY)');
    console.error('For local Supabase, get it from `supabase status` (the "Secret" value).');
    process.exit(1);
  }

  // --- Clients ---
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(serviceAccountJson),
    scopes: ['https://www.googleapis.com/auth/documents.readonly'],
  });
  const docsClient = google.docs({ version: 'v1', auth });

  process.stdout.write(`Loading local embedding model (${EMBED_MODEL})... `);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const embedder = (await (pipeline as any)('feature-extraction', EMBED_MODEL)) as FeatureExtractionPipeline;
  console.log('ready.');
  const supabase = createClient(supabaseUrl, supabaseKey, {
    db: { schema: 'internal_cs' },
  });

  // --- Fetch document (includeTabsContent=true to get all tabs, not just first) ---
  process.stdout.write(`Fetching document ${docId}... `);
  const { data: doc } = await docsClient.documents.get({
    documentId: docId,
    includeTabsContent: true,
  });
  console.log(`"${doc.title}"`);

  const tabCount = doc.tabs?.length ?? 0;
  if (tabCount > 0) {
    console.log(`Found ${tabCount} top-level tab(s).`);
  }

  // Save raw doc to file for inspection
  const rawPath = join(REPO_ROOT, 'docs', 'workbook-raw.json');
  writeFileSync(rawPath, JSON.stringify(doc, null, 2));
  console.log(`Raw doc saved to docs/workbook-raw.json\n`);

  // --- Parse ---
  if (DEBUG) console.log('\n--- All paragraphs ---');
  const sections = parseDocSections(doc, docId);
  console.log(`Parsed ${sections.length} heading sections.`);

  if (DEBUG) {
    console.log('\n--- Sections found ---');
    sections.forEach((s, i) => {
      const path = s.tabPath ? `${s.tabPath} > ` : '';
      console.log(`${i + 1}. [${s.headingId}] ${path}${s.title} (${s.content.length} chars)`);
    });
    console.log('\nDebug mode: skipping DB write.');
    return;
  }

  if (sections.length === 0) {
    console.log('\nNo sections found. The doc may use Normal text + bold instead of Heading styles.');
    console.log('Check docs/workbook-raw.json and look at paragraphStyle.namedStyleType values.');
    console.log('Re-run with --debug to see all paragraph styles inline.');
    return;
  }

  // --- Load existing chunks for change detection ---
  console.log(`Connecting to Supabase: ${supabaseUrl} (schema: internal_cs)`);
  const { data: existing, error: fetchErr } = await supabase
    .from('workbook_chunks')
    .select('heading_id, content_hash, embed_model');

  if (fetchErr) {
    console.error('\nFailed to load existing chunks. Full error:');
    console.error(JSON.stringify(fetchErr, null, 2));
    console.error('\nDiagnostics:');
    console.error(`  URL:    ${supabaseUrl}`);
    console.error(`  Key:    ${supabaseKey.slice(0, 12)}...${supabaseKey.slice(-4)} (length ${supabaseKey.length})`);
    if (fetchErr.code === 'PGRST301' || /No suitable key/.test(fetchErr.message)) {
      console.error('\n→ JWT/key mismatch. The service role key does not match the running Supabase.');
      console.error('  Run `supabase status` and use the "Secret" value as SUPABASE_SERVICE_ROLE_KEY.');
    } else if (fetchErr.code === 'PGRST106' || /schema must be one/.test(fetchErr.message)) {
      console.error('\n→ The internal_cs schema is not exposed. Add it to [api] schemas in supabase/config.toml.');
    } else if (/relation .* does not exist/.test(fetchErr.message)) {
      console.error('\n→ The workbook_chunks table is missing. Run the migration SQL.');
    }
    process.exit(1);
  }

  const existingMap = new Map<string, { hash: string; model: string | null }>(
    (existing ?? []).map((r: any) => [r.heading_id, { hash: r.content_hash, model: r.embed_model }])
  );

  // If the embed model differs from any stored row, the existing embeddings are
  // in a different vector space and would produce garbage retrieval. Wipe them.
  const stale = (existing ?? []).filter((r: any) => r.embed_model && r.embed_model !== EMBED_MODEL);
  if (stale.length > 0) {
    console.log(`Detected ${stale.length} chunk(s) embedded with a different model. Wiping for re-embed...`);
    const { error: delErr } = await supabase.from('workbook_chunks').delete().neq('heading_id', '__never__');
    if (delErr) {
      console.error('Failed to wipe stale chunks:', delErr.message);
      process.exit(1);
    }
    existingMap.clear();
  }

  // --- Sync ---
  let created = 0, updated = 0, skipped = 0, failed = 0;

  for (const section of sections) {
    // Prefix tab path so retrieval shows "Module 1 > Lessons > Section Name"
    const fullTitle = section.tabPath ? `${section.tabPath} > ${section.title}` : section.title;
    const chunkText = `${fullTitle}\n\n${section.content}`;
    const hash = createHash('sha256').update(chunkText).digest('hex');
    const existingRow = existingMap.get(section.headingId);

    if (existingRow?.hash === hash && existingRow.model === EMBED_MODEL) {
      process.stdout.write('.');
      skipped++;
      continue;
    }

    const isNew = existingRow === undefined;
    process.stdout.write(isNew ? '+' : '~');

    const embedding = await embedText(embedder, chunkText);
    if (embedding.length !== EMBED_DIMS) {
      console.error(`\n  Failed "${section.title}": got ${embedding.length} dims, expected ${EMBED_DIMS}`);
      failed++;
      continue;
    }

    const { error } = await supabase.from('workbook_chunks').upsert(
      {
        heading_id: section.headingId,
        section_title: fullTitle,
        anchor_link: section.anchorLink,
        content: section.content,
        content_hash: hash,
        embedding,
        embed_model: EMBED_MODEL,
        synced_at: new Date().toISOString(),
      },
      { onConflict: 'heading_id' }
    );

    if (error) {
      console.error(`\n  Failed "${section.title}": ${error.message}`);
      failed++;
    } else {
      isNew ? created++ : updated++;
    }
  }

  // --- Remove sections deleted from the doc ---
  const activeIds = new Set(sections.map(s => s.headingId));
  const staleIds = [...existingMap.keys()].filter(id => !activeIds.has(id));
  if (staleIds.length > 0) {
    await supabase.from('workbook_chunks').delete().in('heading_id', staleIds);
  }

  console.log(`\n\nSync complete:`);
  console.log(`  ${created} inserted, ${updated} updated, ${skipped} unchanged`);
  if (staleIds.length) console.log(`  ${staleIds.length} deleted (removed from doc)`);
  if (failed) console.log(`  ${failed} failed`);
}

main().catch(err => {
  console.error('\nFatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
