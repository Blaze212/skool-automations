#!/usr/bin/env tsx
// doppler run -- tsx automations/free-member-sync/test-scripts/get-chats.ts
import { loadEnv } from '../../shared/env.js';
import { SkoolClient } from '../../shared/skool/skool-client.js';

const GROUP = 'career-systems';
const { SKOOL_EMAIL, SKOOL_PASSWORD } = loadEnv(['SKOOL_EMAIL', 'SKOOL_PASSWORD']);
const skool = new SkoolClient({ email: SKOOL_EMAIL, password: SKOOL_PASSWORD });

try {
  await skool.ensureSession(GROUP);
  const channels = await skool.getChats();
  console.log(JSON.stringify(channels, null, 2));
  console.error(`\n${channels.length} channels`);
} finally {
  await skool.close();
}
