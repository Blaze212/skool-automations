import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../supabase/functions/_shared/supabase-admin.ts', () => ({
  createAdminClient: vi.fn(),
}));

import { createAdminClient } from '../../../supabase/functions/_shared/supabase-admin.ts';
import { handler } from '../../../supabase/functions/linkedin-tracker-provision/linkedin-tracker-provision.ts';

const denoEnvGet = vi.fn();
vi.stubGlobal('Deno', { env: { get: denoEnvGet } });

const SERVICE_ACCOUNT_EMAIL = 'tracker@project.iam.gserviceaccount.com';
const VALID_SHEET_ID = 'abc123xyz_abcdef';
const USER_ID = '11111111-1111-1111-1111-111111111111';
const API_KEY = 'test-api-key-uuid-1234';
const VALID_JWT = 'valid.jwt.token';

function makeRequest(method: string, body?: unknown, jwt?: string) {
  return new Request('http://localhost/functions/v1/linkedin-tracker-provision', {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(jwt !== undefined ? { Authorization: `Bearer ${jwt}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

type AuthResult = { user: { id: string } | null; error: Error | null };
type SelectResult = { api_key: string; sheet_id: string } | null | 'db_error';
type RpcResult = Array<{ api_key: string; sheet_id: string }> | null;

function makeAuthClient(result: AuthResult) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: result.user }, error: result.error }),
    },
  };
}

function makeDbClient(selectResult: SelectResult, rpcResult: RpcResult, rpcError?: Error) {
  const single = vi
    .fn()
    .mockResolvedValue(
      selectResult === 'db_error'
        ? { data: null, error: new Error('db connection failed') }
        : selectResult
          ? { data: selectResult, error: null }
          : { data: null, error: Object.assign(new Error('no rows'), { code: 'PGRST116' }) },
    );
  const eq = vi.fn(() => ({ single }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  const rpc = vi
    .fn()
    .mockResolvedValue(
      rpcError ? { data: null, error: rpcError } : { data: rpcResult, error: null },
    );
  return { from, rpc };
}

function setupMocks({
  user = { id: USER_ID } as { id: string } | null,
  authError = null as Error | null,
  selectResult = null as SelectResult,
  rpcResult = null as RpcResult,
  rpcError = undefined as Error | undefined,
  envEmail = SERVICE_ACCOUNT_EMAIL as string | null,
} = {}) {
  const authClient = makeAuthClient({ user, error: authError });
  const dbClient = makeDbClient(selectResult, rpcResult, rpcError);

  vi.mocked(createAdminClient).mockImplementation((schema?: string) => {
    if (!schema) return authClient as ReturnType<typeof createAdminClient>;
    return dbClient as ReturnType<typeof createAdminClient>;
  });

  denoEnvGet.mockImplementation((key: string) => {
    const env: Record<string, string> = {
      SUPABASE_URL: 'http://localhost:54331',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
      ...(envEmail !== null ? { GOOGLE_SERVICE_ACCOUNT_EMAIL: envEmail } : {}),
    };
    return env[key];
  });

  return { authClient, dbClient };
}

describe('linkedin-tracker-provision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('OPTIONS preflight → 204', async () => {
    const res = await handler(
      new Request('http://localhost/functions/v1/linkedin-tracker-provision', {
        method: 'OPTIONS',
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.cmcareersystems.com');
  });

  describe('POST', () => {
    it('valid JWT + new user → 200 with api_key, sheet_id, service_account_email', async () => {
      setupMocks({ rpcResult: [{ api_key: API_KEY, sheet_id: VALID_SHEET_ID }] });
      const res = await handler(makeRequest('POST', { sheet_id: VALID_SHEET_ID }, VALID_JWT));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.api_key).toBe(API_KEY);
      expect(body.sheet_id).toBe(VALID_SHEET_ID);
      expect(body.service_account_email).toBe(SERVICE_ACCOUNT_EMAIL);
    });

    it('valid JWT + existing user, same sheet_id → 200 with same api_key', async () => {
      setupMocks({ rpcResult: [{ api_key: API_KEY, sheet_id: VALID_SHEET_ID }] });
      const res = await handler(makeRequest('POST', { sheet_id: VALID_SHEET_ID }, VALID_JWT));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.api_key).toBe(API_KEY);
    });

    it('valid JWT + existing user, new sheet_id → 200 with same api_key, updated sheet_id', async () => {
      const newSheetId = 'newsheetidxyz1234';
      setupMocks({ rpcResult: [{ api_key: API_KEY, sheet_id: newSheetId }] });
      const res = await handler(makeRequest('POST', { sheet_id: newSheetId }, VALID_JWT));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.api_key).toBe(API_KEY);
      expect(body.sheet_id).toBe(newSheetId);
    });

    it('missing Authorization header → 403', async () => {
      setupMocks();
      const res = await handler(makeRequest('POST', { sheet_id: VALID_SHEET_ID }));
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe('ACCESS_DENIED');
    });

    it('invalid JWT (401 from auth service) → 403', async () => {
      const tokenError = Object.assign(new Error('invalid JWT'), { status: 401 });
      setupMocks({ user: null, authError: tokenError });
      const res = await handler(makeRequest('POST', { sheet_id: VALID_SHEET_ID }, VALID_JWT));
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe('ACCESS_DENIED');
    });

    it('auth service failure (non-401 error) → 500', async () => {
      const serviceError = new Error('network timeout');
      setupMocks({ user: null, authError: serviceError });
      const res = await handler(makeRequest('POST', { sheet_id: VALID_SHEET_ID }, VALID_JWT));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.code).toBe('INTERNAL_ERROR');
    });

    it('missing sheet_id → 400', async () => {
      setupMocks();
      const res = await handler(makeRequest('POST', {}, VALID_JWT));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe('VALIDATION_ERROR');
    });

    it('sheet_id too short → 400', async () => {
      setupMocks();
      const res = await handler(makeRequest('POST', { sheet_id: 'short' }, VALID_JWT));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe('VALIDATION_ERROR');
    });

    it('sheet_id with invalid chars → 400', async () => {
      setupMocks();
      const res = await handler(
        makeRequest('POST', { sheet_id: 'invalid sheet id!!!' }, VALID_JWT),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe('VALIDATION_ERROR');
    });

    it('DB upsert throws → 500', async () => {
      setupMocks({ rpcError: new Error('DB connection failed') });
      const res = await handler(makeRequest('POST', { sheet_id: VALID_SHEET_ID }, VALID_JWT));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.code).toBe('INTERNAL_ERROR');
    });

    it('GOOGLE_SERVICE_ACCOUNT_EMAIL not set → 500', async () => {
      setupMocks({ envEmail: null });
      const res = await handler(makeRequest('POST', { sheet_id: VALID_SHEET_ID }, VALID_JWT));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.code).toBe('INTERNAL_ERROR');
    });
  });

  describe('GET', () => {
    it('authenticated user with existing row → 200', async () => {
      setupMocks({ selectResult: { api_key: API_KEY, sheet_id: VALID_SHEET_ID } });
      const res = await handler(makeRequest('GET', undefined, VALID_JWT));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.api_key).toBe(API_KEY);
      expect(body.sheet_id).toBe(VALID_SHEET_ID);
      expect(body.service_account_email).toBe(SERVICE_ACCOUNT_EMAIL);
    });

    it('authenticated user no row → 404', async () => {
      setupMocks({ selectResult: null });
      const res = await handler(makeRequest('GET', undefined, VALID_JWT));
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.code).toBe('NOT_FOUND');
    });

    it('no Authorization header → 403', async () => {
      setupMocks();
      const res = await handler(makeRequest('GET'));
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe('ACCESS_DENIED');
    });

    it('invalid JWT → 403', async () => {
      const tokenError = Object.assign(new Error('invalid JWT'), { status: 401 });
      setupMocks({ user: null, authError: tokenError });
      const res = await handler(makeRequest('GET', undefined, VALID_JWT));
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe('ACCESS_DENIED');
    });

    it('GOOGLE_SERVICE_ACCOUNT_EMAIL not set → 500', async () => {
      setupMocks({ selectResult: { api_key: API_KEY, sheet_id: VALID_SHEET_ID }, envEmail: null });
      const res = await handler(makeRequest('GET', undefined, VALID_JWT));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.code).toBe('INTERNAL_ERROR');
    });

    it('DB error (non-PGRST116) → 500', async () => {
      setupMocks({ selectResult: 'db_error' });
      const res = await handler(makeRequest('GET', undefined, VALID_JWT));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.code).toBe('INTERNAL_ERROR');
    });
  });
});
