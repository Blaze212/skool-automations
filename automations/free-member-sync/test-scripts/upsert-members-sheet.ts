#!/usr/bin/env tsx
// pnpm test:upsert-members-sheet   (JSON summary → stdout, pino logs → stderr)
import pino from 'pino';
import { loadEnv } from '../../shared/env.js';
import { MembersSheet } from '../members-sheet.js';
import type { SkoolMember } from '../../shared/skool/types.js';

const { GOOGLE_SERVICE_ACCOUNT_JSON, SKOOL_FREE_MEMBER_SYNC_SHEET_ID } = loadEnv([
  'GOOGLE_SERVICE_ACCOUNT_JSON',
  'SKOOL_FREE_MEMBER_SYNC_SHEET_ID',
]);
const log = pino(
  { name: 'upsert-members-sheet', level: 'debug' },
  pino.destination(process.stderr),
);
const sheets = new MembersSheet(GOOGLE_SERVICE_ACCOUNT_JSON, SKOOL_FREE_MEMBER_SYNC_SHEET_ID);

const BASE_MEMBERS: SkoolMember[] = [
  {
    skoolId: 'test-member-001',
    name: 'Alice Test',
    joinDate: '2026-01-01T00:00:00Z',
    lastLoginDate: '2026-05-01T00:00:00Z',
    email: 'alice@example.com',
    currentSituation: 'Employed full-time',
    mainGoal: 'Land a new role in 6 months',
  },
  {
    skoolId: 'test-member-002',
    name: 'Bob Test',
    joinDate: '2026-02-01T00:00:00Z',
    lastLoginDate: '2026-05-10T00:00:00Z',
    email: 'bob@example.com',
    currentSituation: 'Freelancing',
    mainGoal: 'Build a stable client base',
  },
];

// Phase 1: insert both members
log.info({ count: BASE_MEMBERS.length }, 'phase 1 — inserting test members');
const phase1 = await sheets.upsertMembers(BASE_MEMBERS);
log.info(phase1, 'phase 1 done');

// Phase 2: update existing + insert a new one
const UPDATED_MEMBERS: SkoolMember[] = [
  {
    ...BASE_MEMBERS[0]!,
    lastLoginDate: '2026-05-19T12:00:00Z', // updated login date
    mainGoal: 'Updated goal after coaching call',
  },
  BASE_MEMBERS[1]!,
  {
    skoolId: 'test-member-003',
    name: 'Carol Test',
    joinDate: '2026-05-19T00:00:00Z',
    lastLoginDate: '2026-05-19T15:00:00Z',
    email: 'carol@example.com',
    currentSituation: 'Between jobs',
    mainGoal: 'Get first offer within 3 months',
  },
];

log.info({ count: UPDATED_MEMBERS.length }, 'phase 2 — update 2 existing + insert 1 new');
const phase2 = await sheets.upsertMembers(UPDATED_MEMBERS);
log.info(phase2, 'phase 2 done');

// Read back to verify
log.info('reading back Members sheet to verify');
const rows = await sheets.readAllMembers();
const testRows = rows.filter((r) => r[1]?.startsWith('test-member-'));
log.info({ count: testRows.length }, 'test rows found in sheet');

const summary = {
  phase1,
  phase2,
  testRowsInSheet: testRows.map((r) => ({
    name: r[0],
    skoolId: r[1],
    joinDate: r[2],
    lastLoginDate: r[3],
    currentSituation: r[4],
    mainGoal: r[5],
    email: r[6],
  })),
};

console.log(JSON.stringify(summary, null, 2));
