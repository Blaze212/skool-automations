#!/usr/bin/env tsx
/**
 * chat-workbook.ts
 *
 * Interactive REPL to test the workbook RAG. Type a question, get an answer
 * grounded in the most relevant workbook sections. Multi-turn — the model
 * sees the prior turns of the conversation.
 *
 * Run: doppler run -- pnpm tsx scripts/chat-workbook.ts
 *
 * Commands inside the REPL:
 *   /reset   start a fresh conversation
 *   /quit    exit (Ctrl-D also works)
 */

import Anthropic from '@anthropic-ai/sdk';
import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as readline from 'readline';

const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';
const EMBED_MODEL = 'Xenova/all-mpnet-base-v2';
const TOP_K = 4;
const MIN_SIMILARITY = 0.2;

const SYSTEM_PROMPT = `You are Katie, a career coach and founder of CareerSystems, answering a question about your job-search workbook.

STRICT GROUNDING:
- Answer ONLY from the workbook sections provided below. Do not draw on outside knowledge or general career advice.
- If the sections don't actually cover the question, say "The workbook doesn't cover that directly" and stop. Do not improvise an answer.
- Never invent section titles, page numbers, or quotes. Only cite section titles that appear in the provided context.
- Quote or paraphrase specifics from the sections. Do not generalize beyond what they say.

Tone: direct and warm. Confident and specific. Conversational prose, not bullet lists. Cite the section title when you draw from it, and include the link if one is provided.`;

interface WorkbookChunk {
  section_title: string;
  content: string;
  anchor_link: string | null;
  similarity: number;
}

async function retrieveChunks(
  supabase: SupabaseClient,
  embedder: FeatureExtractionPipeline,
  query: string,
): Promise<WorkbookChunk[]> {
  const output = await embedder(query, { pooling: 'mean', normalize: true });
  const queryEmbedding = Array.from(output.data as Float32Array);

  const { data, error } = await supabase.schema('internal_cs').rpc('match_workbook_chunks', {
    query_embedding: queryEmbedding,
    match_count: TOP_K,
    min_similarity: MIN_SIMILARITY,
  });

  if (error) throw error;
  return (data ?? []) as WorkbookChunk[];
}

function formatChunks(chunks: WorkbookChunk[]): string {
  return chunks
    .map((c) => {
      const link = c.anchor_link ? `\nLink: ${c.anchor_link}` : '';
      return `### ${c.section_title}\n${c.content}${link}`;
    })
    .join('\n\n');
}

function ask(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

async function main() {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
  const supabaseUrl = process.env.SUPABASE_URL ?? LOCAL_SUPABASE_URL;

  if (!anthropicKey) {
    console.error('Missing: ANTHROPIC_API_KEY');
    process.exit(1);
  }
  if (!supabaseKey) {
    console.error('Missing: SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY)');
    process.exit(1);
  }

  const anthropic = new Anthropic({ apiKey: anthropicKey });
  const supabase = createClient(supabaseUrl, supabaseKey);

  process.stdout.write(`Loading local embedding model (${EMBED_MODEL})... `);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const embedder = (await (pipeline as any)(
    'feature-extraction',
    EMBED_MODEL,
  )) as FeatureExtractionPipeline;
  console.log('ready.');
  console.log(`Supabase: ${supabaseUrl} (schema: internal_cs)`);
  console.log('Type a question. /reset to clear history, /quit to exit.\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const history: Anthropic.Messages.MessageParam[] = [];

  try {
    while (true) {
      const input = (await ask(rl, '> ')).trim();
      if (!input) continue;
      if (input === '/quit' || input === '/exit') break;
      if (input === '/reset') {
        history.length = 0;
        console.log('(history cleared)\n');
        continue;
      }

      let chunks: WorkbookChunk[] = [];
      try {
        chunks = await retrieveChunks(supabase, embedder, input);
      } catch (err: any) {
        console.error(`Retrieval error: ${err?.message ?? err}\n`);
        continue;
      }

      if (chunks.length === 0) {
        console.log("\nThe workbook doesn't cover that directly. Try rephrasing.\n");
        continue;
      }

      console.log('Retrieved:');
      chunks.forEach((c) =>
        console.log(`  · ${c.section_title}  (${Math.round(c.similarity * 100)}%)`),
      );

      const systemBlocks: Anthropic.Messages.TextBlockParam[] = [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: `## Workbook Sections\n\n${formatChunks(chunks)}` },
      ];

      history.push({ role: 'user', content: input });

      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: systemBlocks,
        messages: history,
      });

      const reply = response.content[0].type === 'text' ? response.content[0].text.trim() : '';
      history.push({ role: 'assistant', content: reply });

      console.log(`\n${reply}\n`);
    }
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error('\nFatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
