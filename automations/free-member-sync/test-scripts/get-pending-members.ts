#!/usr/bin/env tsx
// doppler run -- tsx automations/free-member-sync/test-scripts/get-pending-members.ts
import { loadEnv } from '../../shared/env.js';
import { SkoolClient } from '../../shared/skool/skool-client.js';

const GROUP = 'career-systems';
const { SKOOL_EMAIL, SKOOL_PASSWORD } = loadEnv(['SKOOL_EMAIL', 'SKOOL_PASSWORD']);
const skool = new SkoolClient({ email: SKOOL_EMAIL, password: SKOOL_PASSWORD });

try {
  await skool.ensureSession(GROUP);
  const members = await skool.getPendingMembers(GROUP);
  console.log(JSON.stringify(members, null, 2));
  console.error(`\n${members.length} pending members`);
} finally {
  await skool.close();
}
