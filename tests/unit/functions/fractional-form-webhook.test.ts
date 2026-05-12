import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../supabase/functions/_shared/supabase-admin.ts', () => ({
  createAdminClient: vi.fn(),
}));

vi.mock('../../../supabase/functions/_shared/drive.ts', () => ({
  createClientFolder: vi.fn().mockResolvedValue('folder-id'),
  copyWorkbookTemplate: vi.fn().mockResolvedValue('doc-id'),
  shareFolder: vi.fn().mockResolvedValue(undefined),
}));

import { createAdminClient } from '../../../supabase/functions/_shared/supabase-admin.ts';
import {
  createClientFolder,
  copyWorkbookTemplate,
  shareFolder,
} from '../../../supabase/functions/_shared/drive.ts';

const denoEnvGet = vi.fn();
vi.stubGlobal('Deno', { env: { get: denoEnvGet } });

// Import handler directly — no need to capture it through serve()
import { handler } from '../../../supabase/functions/fractional-onboarding-form-webhook/fractional-onboarding-form-webhook.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_SECRET = 'test-secret';
const VALID_BODY = {
  data: {
    'Client full name': ['Jane Doe'],
    'Email for Google Drive sharing': ['jane@example.com'],
    'Email for Skool (leave blank if same as Drive email)': [''],
    'Program start date': ['2026-06-01'],
    Notes: [''],
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

type QueryResult = { data: Record<string, string> | null; error: Error | null };

function makeDbMock(clientResult: QueryResult, runResult: QueryResult) {
  const single = vi.fn().mockResolvedValueOnce(clientResult).mockResolvedValueOnce(runResult);
  const select = vi.fn(() => ({ single }));
  const insert = vi.fn(() => ({ select }));
  const eq = vi.fn().mockResolvedValue({ data: null, error: null });
  const update = vi.fn(() => ({ eq }));
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

  it('returns 200 success:false with VALIDATION_ERROR when required fields are missing', async () => {
    const res = await handler(
      makeRequest({
        secret: VALID_SECRET,
        body: { data: { 'Client full name': ['Jane Doe'] } },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 200 ok:true on happy path', async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeDbMock(
        { data: { id: 'client-uuid' }, error: null },
        { data: { id: 'run-uuid' }, error: null },
      ) as ReturnType<typeof createAdminClient>,
    );

    const res = await handler(makeRequest({ secret: VALID_SECRET, body: VALID_BODY }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('calls Drive functions with client name and email on happy path', async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeDbMock(
        { data: { id: 'client-uuid' }, error: null },
        { data: { id: 'run-uuid' }, error: null },
      ) as ReturnType<typeof createAdminClient>,
    );

    await handler(makeRequest({ secret: VALID_SECRET, body: VALID_BODY }));

    expect(createClientFolder).toHaveBeenCalledWith('Jane Doe');
    expect(copyWorkbookTemplate).toHaveBeenCalledWith('folder-id', 'Jane Doe');
    expect(shareFolder).toHaveBeenCalledWith('folder-id', 'jane@example.com');
  });

  it('returns 200 success:false when client DB insert fails', async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeDbMock(
        { data: null, error: new Error('duplicate email') },
        { data: null, error: null },
      ) as ReturnType<typeof createAdminClient>,
    );

    const res = await handler(makeRequest({ secret: VALID_SECRET, body: VALID_BODY }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
  });
});
