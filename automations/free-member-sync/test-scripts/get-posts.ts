#!/usr/bin/env tsx
// doppler run -- tsx automations/free-member-sync/test-scripts/get-posts.ts
import { loadEnv } from '../../shared/env.js';
import { SkoolClient } from '../../shared/skool/skool-client.js';

const GROUP = 'career-systems';
const { SKOOL_EMAIL, SKOOL_PASSWORD } = loadEnv(['SKOOL_EMAIL', 'SKOOL_PASSWORD']);
const skool = new SkoolClient({ email: SKOOL_EMAIL, password: SKOOL_PASSWORD });

try {
  await skool.ensureSession(GROUP);
  const posts = await skool.getPosts(GROUP);
  console.log(JSON.stringify(posts, null, 2));
  console.error(`\n${posts.length} posts`);
} finally {
  await skool.close();
}
