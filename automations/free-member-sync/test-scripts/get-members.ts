#!/usr/bin/env tsx
// pnpm test:get-members   (JSON → logs/scriptout.log, pino logs → stderr)
import pino from 'pino';
import { loadEnv } from '../../shared/env.js';
import { SkoolClient } from '../../shared/skool/skool-client.js';

const GROUP = 'career-systems';
const { SKOOL_EMAIL, SKOOL_PASSWORD } = loadEnv(['SKOOL_EMAIL', 'SKOOL_PASSWORD']);
const log = pino({ name: 'get-members', level: 'debug' }, pino.destination(process.stderr));
const skool = new SkoolClient({ email: SKOOL_EMAIL, password: SKOOL_PASSWORD });

try {
  log.info({ group: GROUP }, 'ensuring session');
  await skool.ensureSession(GROUP);
  log.info('session ready');
  const members = await skool.listMembersAsAdmin({ group: GROUP, maxPages: 2, log });
  console.log(JSON.stringify(members, null, 2));
} finally {
  await skool.close();
}
