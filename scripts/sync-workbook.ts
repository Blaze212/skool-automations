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
import { GoogleGenerativeAI, TaskType } from '@google/generative-ai';
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEBUG = process.argv.includes('--debug');
const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..');

// supabase start defaults — no env vars needed for local dev
const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';
const LOCAL_SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hj04zWl196z0-96T4';

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

async function main() {
  const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const docId = process.env.GOOGLE_DOC_WORKBOOK_ID;
  const googleAiKey = process.env.GOOGLE_AI_API_KEY;
  const supabaseUrl = process.env.SUPABASE_URL ?? LOCAL_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? LOCAL_SERVICE_ROLE_KEY;

  if (!serviceAccountJson) { console.error('Missing: GOOGLE_SERVICE_ACCOUNT_JSON'); process.exit(1); }
  if (!docId) { console.error('Missing: GOOGLE_DOC_WORKBOOK_ID'); process.exit(1); }
  if (!googleAiKey) { console.error('Missing: GOOGLE_AI_API_KEY'); process.exit(1); }

  // --- Clients ---
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(serviceAccountJson),
    scopes: ['https://www.googleapis.com/auth/documents.readonly'],
  });
  const docsClient = google.docs({ version: 'v1', auth });
  const genAI = new GoogleGenerativeAI(googleAiKey);
  const embeddingModel = genAI.getGenerativeModel({ model: 'text-embedding-004' });
  const supabase = createClient(supabaseUrl, supabaseKey, {
    db: { schema: 'skool' },
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
  const { data: existing, error: fetchErr } = await supabase
    .from('workbook_chunks')
    .select('heading_id, content_hash');

  if (fetchErr) {
    console.error('Failed to load existing chunks:', fetchErr.message);
    console.error('Make sure you ran the migration SQL and local Supabase is running (supabase start).');
    process.exit(1);
  }

  const existingMap = new Map<string, string>(
    (existing ?? []).map((r: any) => [r.heading_id, r.content_hash])
  );

  // --- Sync ---
  let created = 0, updated = 0, skipped = 0, failed = 0;

  for (const section of sections) {
    // Prefix tab path so retrieval shows "Module 1 > Lessons > Section Name"
    const fullTitle = section.tabPath ? `${section.tabPath} > ${section.title}` : section.title;
    const chunkText = `${fullTitle}\n\n${section.content}`;
    const hash = createHash('sha256').update(chunkText).digest('hex');
    const existingHash = existingMap.get(section.headingId);

    if (existingHash === hash) {
      process.stdout.write('.');
      skipped++;
      continue;
    }

    const isNew = existingHash === undefined;
    process.stdout.write(isNew ? '+' : '~');

    const embedResult = await embeddingModel.embedContent({
      content: { role: 'user', parts: [{ text: chunkText }] },
      taskType: TaskType.RETRIEVAL_DOCUMENT,
    });

    const { error } = await supabase.from('workbook_chunks').upsert(
      {
        heading_id: section.headingId,
        section_title: fullTitle,
        anchor_link: section.anchorLink,
        content: section.content,
        content_hash: hash,
        embedding: embedResult.embedding.values,
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
