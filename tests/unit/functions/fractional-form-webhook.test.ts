import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../supabase/functions/_shared/supabase-admin.ts', () => ({
  createAdminClient: vi.fn(),
}));

vi.mock('../../../supabase/functions/_shared/google-drive.ts', () => {
  const mockDrive = {
    createClientFolder: vi.fn().mockResolvedValue('folder-id'),
    copyWorkbookTemplate: vi.fn().mockResolvedValue('doc-id'),
    shareFolder: vi.fn().mockResolvedValue(undefined),
  };
  return { createGoogleDriveClient: vi.fn().mockReturnValue(mockDrive) };
});

import { createAdminClient } from '../../../supabase/functions/_shared/supabase-admin.ts';
import { createGoogleDriveClient } from '../../../supabase/functions/_shared/google-drive.ts';

const denoEnvGet = vi.fn();
vi.stubGlobal('Deno', { env: { get: denoEnvGet } });

import { handler } from '../../../supabase/functions/fractional-onboarding-form-webhook/fractional-onboarding-form-webhook.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_SECRET = 'test-secret';
const VALID_BODY = {
  data: {
    full_name: 'Jane Doe',
    email_google_drive: 'jane@example.com',
    email_skool: '',
    program_start_date: '2026-06-01',
    user_notes: '',
  },
};

function makeRequest(opts: { secret?: string; body?: unknown } = {}) {
  return new Request('http://localhost/functions/v1/fractional-onboarding-form-webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.secret !== undefined ? { 'X-Webhook-Secret': opts.secret } : {}),
    },
    body: JSON.stringify(opts.body ?? {}),
  });
}

// Minimal FractionalDb-compatible mock: insert → select → single chain returns given values.
function makeDbMock(clientId: string | null, runId: string | null) {
  const clientSingle = vi
    .fn()
    .mockResolvedValue(
      clientId
        ? { data: { id: clientId }, error: null }
        : { data: null, error: new Error('db error') },
    );
  const runSingle = vi
    .fn()
    .mockResolvedValue(
      runId ? { data: { id: runId }, error: null } : { data: null, error: new Error('db error') },
    );
  const eq = vi.fn().mockResolvedValue({ data: null, error: null });
  const update = vi.fn(() => ({ eq }));

  let selectCallCount = 0;
  const select = vi.fn(() => {
    selectCallCount++;
    return { single: selectCallCount === 1 ? clientSingle : runSingle };
  });
  const insert = vi.fn(() => ({ select }));
  const from = vi.fn(() => ({ insert, update }));
  return { from };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fractional-onboarding-form-webhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    denoEnvGet.mockImplementation((key: string) => {
      const env: Record<string, string> = {
        GOOGLE_APP_SCRIPTS_WEBHOOK_SECRET: VALID_SECRET,
        SUPABASE_URL: 'http://localhost:54331',
        SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
        SUPABASE_ANON_KEY: 'test-anon-key',
      };
      return env[key];
    });
  });

  it('returns 401 when X-Webhook-Secret header is absent', async () => {
    const res = await handler(makeRequest({ body: VALID_BODY }));
    expect(res.status).toBe(401);
  });

  it('returns 401 when X-Webhook-Secret is wrong', async () => {
    const res = await handler(makeRequest({ secret: 'wrong-secret', body: VALID_BODY }));
    expect(res.status).toBe(401);
  });

  it('returns 200 with VALIDATION_ERROR when required fields are missing', async () => {
    const res = await handler(
      makeRequest({ secret: VALID_SECRET, body: { data: { full_name: 'Jane Doe' } } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 200 ok:true on happy path', async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeDbMock('client-uuid', 'run-uuid') as ReturnType<typeof createAdminClient>,
    );

    const res = await handler(makeRequest({ secret: VALID_SECRET, body: VALID_BODY }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('calls Drive client methods with correct arguments on happy path', async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeDbMock('client-uuid', 'run-uuid') as ReturnType<typeof createAdminClient>,
    );

    await handler(makeRequest({ secret: VALID_SECRET, body: VALID_BODY }));

    const drive = vi.mocked(createGoogleDriveClient).mock.results[0].value;
    expect(drive.createClientFolder).toHaveBeenCalledWith('Jane Doe');
    expect(drive.copyWorkbookTemplate).toHaveBeenCalledWith('folder-id', 'Jane Doe');
    expect(drive.shareFolder).toHaveBeenCalledWith('folder-id', 'jane@example.com');
  });

  it('returns 200 success:false when client DB insert fails', async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeDbMock(null, null) as ReturnType<typeof createAdminClient>,
    );

    const res = await handler(makeRequest({ secret: VALID_SECRET, body: VALID_BODY }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
  });
});
