#!/usr/bin/env tsx
// doppler run -- tsx automations/free-member-sync/test-scripts/get-chat-messages.ts <channelId>
// Run get-chats.ts first to find a channel ID.
import { loadEnv } from '../../shared/env.js';
import { SkoolClient } from '../../shared/skool/skool-client.js';

const channelId = process.argv[2];
if (!channelId) {
  console.error('Usage: tsx get-chat-messages.ts <channelId>');
  process.exit(1);
}

const GROUP = 'career-systems';
const { SKOOL_EMAIL, SKOOL_PASSWORD } = loadEnv(['SKOOL_EMAIL', 'SKOOL_PASSWORD']);
const skool = new SkoolClient({ email: SKOOL_EMAIL, password: SKOOL_PASSWORD });

try {
  await skool.ensureSession(GROUP);
  const messages = await skool.getChatMessages(channelId);
  console.log(JSON.stringify(messages, null, 2));
  console.error(`\n${messages.length} messages`);
} finally {
  await skool.close();
}
