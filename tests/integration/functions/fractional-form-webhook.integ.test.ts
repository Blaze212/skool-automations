/**
 * Integration tests for fractional-onboarding-form-webhook.
 *
 * Requires the local Supabase stack to be running:
 *   pnpm db:start && pnpm migrate:local && pnpm test:integ
 *
 * SUPABASE_SERVICE_ROLE_KEY is auto-fetched from `supabase status`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';

vi.mock('../../../supabase/functions/_shared/drive.ts', () => ({
  createClientFolder: vi.fn().mockResolvedValue('integ-test-folder-id'),
  copyWorkbookTemplate: vi.fn().mockResolvedValue('integ-test-doc-id'),
  shareFolder: vi.fn().mockResolvedValue(undefined),
}));

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54331';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const WEBHOOK_SECRET = process.env.GOOGLE_APP_SCRIPTS_WEBHOOK_SECRET ?? 'local-test-secret';

if (!SERVICE_KEY) {
  throw new Error(
    'SUPABASE_SERVICE_ROLE_KEY not found — is the local Supabase stack running?\n' +
      '  pnpm db:start && pnpm migrate:local',
  );
}

vi.stubGlobal('Deno', {
  env: {
    get: (key: string) =>
      ({
        GOOGLE_APP_SCRIPTS_WEBHOOK_SECRET: WEBHOOK_SECRET,
        SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
      })[key],
  },
});

import { handler } from '../../../supabase/functions/fractional-onboarding-form-webhook/fractional-onboarding-form-webhook.ts';

const db = createClient(SUPABASE_URL, SERVICE_KEY, { db: { schema: 'internal_cs' } });

const TEST_EMAIL = 'integ-test@example.com';

async function cleanup() {
  const { data: clients } = await db
    .from('fractional_clients')
    .select('id')
    .eq('drive_email', TEST_EMAIL);

  if (clients?.length) {
    await db
      .from('fractional_workflow_runs')
      .delete()
      .in(
        'client_id',
        clients.map((c: { id: string }) => c.id),
      );
    await db.from('fractional_clients').delete().eq('drive_email', TEST_EMAIL);
  }
}

function makeRequest(data: Record<string, string>) {
  return new Request('http://localhost/functions/v1/fractional-onboarding-form-webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Secret': WEBHOOK_SECRET,
    },
    body: JSON.stringify({ data }),
  });
}

describe('fractional-onboarding-form-webhook (integration)', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('returns ok:true and writes fractional_clients row with correct fields', async () => {
    const res = await handler(
      makeRequest({
        full_name: 'Jane Doe',
        email_google_drive: TEST_EMAIL,
        email_skool: 'jane-skool@example.com',
        program_start_date: '2026-06-01',
        user_notes: 'Integration test client',
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const { data: client, error } = await db
      .from('fractional_clients')
      .select('*')
      .eq('drive_email', TEST_EMAIL)
      .single();

    expect(error).toBeNull();
    expect(client).toMatchObject({
      full_name: 'Jane Doe',
      drive_email: TEST_EMAIL,
      skool_email: 'jane-skool@example.com',
      program_start_date: '2026-06-01',
      notes: 'Integration test client',
      drive_folder_id: 'integ-test-folder-id',
      workbook_doc_id: 'integ-test-doc-id',
    });
  });

  it('writes a completed workflow_run row', async () => {
    await handler(
      makeRequest({
        full_name: 'Jane Doe',
        email_google_drive: TEST_EMAIL,
        email_skool: '',
        program_start_date: '2026-06-01',
        user_notes: '',
      }),
    );

    const { data: client } = await db
      .from('fractional_clients')
      .select('id')
      .eq('drive_email', TEST_EMAIL)
      .single();

    const { data: run, error } = await db
      .from('fractional_workflow_runs')
      .select('*')
      .eq('client_id', client.id)
      .single();

    expect(error).toBeNull();
    expect(run).toMatchObject({
      workflow: 'onboard',
      status: 'complete',
      error: null,
    });
    expect(run.started_at).not.toBeNull();
    expect(run.completed_at).not.toBeNull();
  });

  it('falls back skool_email to drive_email when blank', async () => {
    await handler(
      makeRequest({
        full_name: 'Jane Doe',
        email_google_drive: TEST_EMAIL,
        email_skool: '',
        program_start_date: '',
        user_notes: '',
      }),
    );

    const { data: client } = await db
      .from('fractional_clients')
      .select('skool_email, program_start_date')
      .eq('drive_email', TEST_EMAIL)
      .single();

    expect(client.skool_email).toBe(TEST_EMAIL);
    expect(client.program_start_date).toBeNull();
  });
});
