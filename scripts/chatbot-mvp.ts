#!/usr/bin/env tsx
/**
 * Skool Chatbot MVP
 *
 * Fetches unread DMs from Skool, retrieves relevant workbook sections (RAG),
 * drafts a reply with Claude Sonnet, and asks for y/e/n approval before sending.
 *
 * Run: doppler run -- pnpm tsx scripts/chatbot-mvp.ts
 * Local (no Doppler): SKOOL_EMAIL=... SKOOL_PASSWORD=... ANTHROPIC_API_KEY=... GOOGLE_AI_API_KEY=... pnpm tsx scripts/chatbot-mvp.ts
 *
 * Supabase defaults to local (supabase start) if SUPABASE_URL is not set.
 * RAG is skipped gracefully if the workbook hasn't been synced yet.
 */

import Anthropic from '@anthropic-ai/sdk';
import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SkoolClient } from 'skool-cli';
import type { ChatMessage } from 'skool-cli';
import * as readline from 'readline';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const AUTH_STATE_PATH = join(homedir(), '.skool-cli', 'auth-state.json');

// Default URL only — the secret key is per-installation in newer Supabase CLI
// versions (format: sb_secret_...). Get yours with `supabase status`.
const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';

// ---------------------------------------------------------------------------
// Coaching system prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are Katie, a career coach and founder of CareerSystems, responding to a member of your Skool community via direct message.

## Coaching Framework

Every member has a diagnosed constraint — address theirs based on what they've shared. If unknown, ask one focused clarifying question.

Constraint types:
- Role constraint: unclear which roles to target; needs positioning clarity.
- Message constraint: right roles, weak outreach; needs message optimization.
- Execution constraint: right roles and message, but inconsistent action; needs accountability.

## Tone

Direct and warm. Confident and specific — not vague or cheerleader-y. Write like a trusted coach who has seen hundreds of job searches, not a customer service rep.

## Hard Rules

- Billing / pricing: "For billing questions, reach out to me directly. Happy to sort it out."
- Specific company or role strategy: "That's something I'd want to dig into with you — let's find a time." Do not advise on specific companies.
- Resume critique: Direct to the CareerSystems workbook and the message generator tool. No inline critiques.
- Legal / visa / HR compliance: "That's outside what I can help with here — consult an employment attorney or HR."
- Paid content for free members: Acknowledge it by name, explain it's in the paid community, mention the upgrade option. Do not share the content.

## Format

- Under 500 characters. Be concise.
- Conversational prose, not bullet lists.
- End with a clear next step or question — not open-ended filler.
- Do not start with "I".`;

const COMMUNITY_CONTEXT = `## CareerSystems Resources

- **Workbook** (Google Doc): constraint diagnosis, resume positioning, outreach messaging, execution habits. Direct members to specific sections.
- **Message Generator**: tool to craft personalized outreach messages.
- **Resume Review**: calendar events Katie schedules for members who need feedback.
- **Skool Courses**: structured lessons for each job-search stage.

Free members have limited access. Paid membership is a one-time $497 fee.`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WorkbookChunk {
  section_title: string;
  content: string;
  anchor_link: string | null;
  similarity: number;
}

// ---------------------------------------------------------------------------
// RAG retrieval
// ---------------------------------------------------------------------------

// Must match the model used in sync-workbook.ts
const EMBED_MODEL = 'Xenova/all-mpnet-base-v2';

async function retrieveChunks(
  supabase: SupabaseClient,
  embedder: FeatureExtractionPipeline,
  query: string,
  limit = 3,
): Promise<WorkbookChunk[]> {
  const output = await embedder(query, { pooling: 'mean', normalize: true });
  const queryEmbedding = Array.from(output.data as Float32Array);

  const { data, error } = await supabase.schema('skool').rpc('match_workbook_chunks', {
    query_embedding: queryEmbedding,
    match_count: limit,
  });

  if (error) throw error;
  return (data ?? []) as WorkbookChunk[];
}

function formatChunksForContext(chunks: WorkbookChunk[]): string {
  return chunks
    .map((c) => {
      const link = c.anchor_link ? `\nSee: ${c.anchor_link}` : '';
      return `### ${c.section_title}\n${c.content}${link}`;
    })
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

function formatThread(messages: ChatMessage[], ownerId: string, memberName: string): string {
  return messages
    .map((m) => {
      const sender = m.senderId === ownerId ? 'Katie' : memberName;
      const time = new Date(m.createdAt).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
      return `[${time}] ${sender}: ${m.content}`;
    })
    .join('\n');
}

function divider(label?: string) {
  const line = '─'.repeat(60);
  console.log(label ? `${line}\n${label}` : line);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const email = process.env.SKOOL_EMAIL;
  const password = process.env.SKOOL_PASSWORD;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!email || !password) {
    console.error('Error: SKOOL_EMAIL and SKOOL_PASSWORD must be set.');
    process.exit(1);
  }
  if (!anthropicKey) {
    console.error('Error: ANTHROPIC_API_KEY must be set.');
    process.exit(1);
  }

  // RAG requires Supabase access; embedding is local
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
  const ragEnabled = Boolean(supabaseKey);

  const anthropic = new Anthropic({ apiKey: anthropicKey });
  const skool = new SkoolClient();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const supabase = supabaseKey
    ? createClient(process.env.SUPABASE_URL ?? LOCAL_SUPABASE_URL, supabaseKey)
    : null;

  let embedder: FeatureExtractionPipeline | null = null;
  if (ragEnabled) {
    process.stdout.write(`Loading local embedding model (${EMBED_MODEL})... `);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    embedder = (await (pipeline as any)(
      'feature-extraction',
      EMBED_MODEL,
    )) as FeatureExtractionPipeline;
    console.log('ready.\n');
  } else {
    console.log(
      'Note: RAG disabled (missing SUPABASE_SERVICE_ROLE_KEY). Using base prompt only.\n',
    );
  }

  try {
    // --- Auth: reuse saved session if available, otherwise full login ---
    const hasSavedSession = existsSync(AUTH_STATE_PATH);
    let profileResult = hasSavedSession
      ? await (async () => {
          process.stdout.write('Resuming saved Skool session... ');
          return skool.getProfile();
        })()
      : { success: false, message: 'No saved session', profile: null };

    if (!profileResult.success) {
      if (hasSavedSession) console.log('expired.');
      process.stdout.write('Logging in to Skool... ');
      const loginResult = await skool.login(email, password);
      if (!loginResult.success) {
        console.error('\nLogin failed:', loginResult.message);
        process.exit(1);
      }
      profileResult = await skool.getProfile();
    }

    console.log('done.');

    if (!profileResult.success || !profileResult.profile) {
      console.error('Could not fetch profile:', profileResult.message);
      process.exit(1);
    }
    const owner = profileResult.profile;
    const ownerId = owner.id;
    console.log(`Logged in as: ${owner.firstName} ${owner.lastName} (${owner.email})\n`);

    // --- Get chats ---
    process.stdout.write('Fetching conversations... ');
    const chatsResult = await skool.getChats();
    if (!chatsResult.success) {
      console.error('\nCould not fetch chats:', chatsResult.message);
      process.exit(1);
    }

    const unread = chatsResult.channels.filter((c) => c.unreadCount > 0);
    console.log(`done. ${chatsResult.channels.length} total, ${unread.length} unread.\n`);

    if (unread.length === 0) {
      console.log('No unread DMs. Nothing to do.');
      return;
    }

    let sent = 0;
    let skipped = 0;

    // --- Process each unread chat ---
    for (const channel of unread) {
      divider(`DM with: ${channel.userName}  (${channel.unreadCount} unread)`);
      console.log(`Preview: ${channel.lastMessagePreview}\n`);

      // Fetch full thread
      process.stdout.write('Fetching thread... ');
      const msgResult = await skool.getChatMessages(channel.id);
      if (!msgResult.success || msgResult.messages.length === 0) {
        console.log('failed or empty — skipping.\n');
        continue;
      }
      console.log(`${msgResult.messages.length} messages.\n`);

      const messages = msgResult.messages;
      const lastMsg = messages[messages.length - 1];

      // Echo guard
      if (lastMsg.senderId === ownerId) {
        console.log('Last message is from Katie — no reply needed. Skipping.\n');
        skipped++;
        continue;
      }

      // Display thread
      const threadText = formatThread(messages, ownerId, channel.userName);
      console.log('THREAD:\n');
      console.log(threadText);
      console.log();

      // --- RAG retrieval ---
      let chunks: WorkbookChunk[] = [];
      if (ragEnabled && embedder && supabase) {
        process.stdout.write('Retrieving workbook context... ');
        try {
          const memberMessages = messages.filter((m) => m.senderId !== ownerId);
          const query = memberMessages[memberMessages.length - 1]?.content ?? lastMsg.content;
          chunks = await retrieveChunks(supabase, embedder, query);
          if (chunks.length > 0) {
            console.log(`${chunks.length} section(s) found.`);
            chunks.forEach((c) =>
              console.log(`  · ${c.section_title} (${Math.round(c.similarity * 100)}% match)`),
            );
          } else {
            console.log('no relevant sections found.');
          }
        } catch (err: any) {
          const msg = err?.message ?? String(err);
          if (msg.includes('relation') || msg.includes('does not exist')) {
            console.log('workbook not synced yet — run sync-workbook.ts first.');
          } else if (err?.code === 'PGRST301' || /No suitable key/.test(msg)) {
            console.log(
              'JWT/key mismatch. Run `supabase status` and update SUPABASE_SERVICE_ROLE_KEY.',
            );
          } else {
            console.log(`retrieval error: ${msg}`);
            if (err?.code) console.log(`  (code: ${err.code})`);
          }
          chunks = [];
        }
        console.log();
      }

      // --- Draft with Claude ---
      process.stdout.write('Drafting with Claude Sonnet... ');

      const systemBlocks: Anthropic.Messages.TextBlockParam[] = [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: COMMUNITY_CONTEXT, cache_control: { type: 'ephemeral' } },
      ];

      if (chunks.length > 0) {
        systemBlocks.push({
          type: 'text',
          text: `## Relevant Workbook Sections\n\nUse these to inform your reply. Cite the section name and include the link when relevant.\n\n${formatChunksForContext(chunks)}`,
        });
      }

      const aiResponse = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 200,
        system: systemBlocks,
        messages: [
          {
            role: 'user',
            content: `DM thread with community member ${channel.userName}. Draft a reply as Katie.\n\n${threadText}\n\nKatie:`,
          },
        ],
      });

      const draft = aiResponse.content[0].type === 'text' ? aiResponse.content[0].text.trim() : '';
      console.log('done.\n');

      console.log('DRAFT REPLY:\n');
      console.log(draft);
      console.log(`\n(${draft.length} chars)`);

      // --- Approval prompt ---
      const choice = await ask(rl, '\n[y] Send  [e] Edit  [n] Skip — choice: ');

      if (choice.toLowerCase() === 'y') {
        process.stdout.write('Sending... ');
        const sendResult = await skool.sendChatMessage(channel.id, draft);
        if (sendResult.success) {
          console.log('Sent!\n');
          sent++;
        } else {
          console.error(`Send failed: ${sendResult.message}\n`);
        }
      } else if (choice.toLowerCase() === 'e') {
        const edited = await ask(rl, 'Your reply: ');
        const trimmed = edited.trim();
        if (trimmed) {
          process.stdout.write('Sending... ');
          const sendResult = await skool.sendChatMessage(channel.id, trimmed);
          if (sendResult.success) {
            console.log('Sent!\n');
            sent++;
          } else {
            console.error(`Send failed: ${sendResult.message}\n`);
          }
        } else {
          console.log('Empty reply — skipping.\n');
          skipped++;
        }
      } else {
        console.log('Skipped.\n');
        skipped++;
      }
    }

    // --- Summary ---
    divider();
    console.log(`Done. ${sent} sent, ${skipped} skipped.`);
  } finally {
    rl.close();
    await skool.close();
  }
}

main().catch((err) => {
  console.error('\nFatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
