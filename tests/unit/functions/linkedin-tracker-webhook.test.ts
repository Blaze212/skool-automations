import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../supabase/functions/_shared/supabase-admin.ts', () => ({
  createAdminClient: vi.fn(),
}));

vi.mock('../../../supabase/functions/_shared/google-sheets.ts', () => {
  const mockSheets = {
    appendRow: vi.fn().mockResolvedValue(undefined),
  };
  return { createGoogleSheetsClient: vi.fn().mockReturnValue(mockSheets) };
});

import { createAdminClient } from '../../../supabase/functions/_shared/supabase-admin.ts';
import { createGoogleSheetsClient } from '../../../supabase/functions/_shared/google-sheets.ts';
import { handler } from '../../../supabase/functions/linkedin-tracker-webhook/linkedin-tracker-webhook.ts';

const denoEnvGet = vi.fn();
vi.stubGlobal('Deno', { env: { get: denoEnvGet } });

const VALID_API_KEY = 'test-api-key-1234';
const SHEET_ID = 'sheet-id-abc';
const VALID_BODY = {
  api_key: VALID_API_KEY,
  date: '2026-05-13',
  name: 'Jane Doe',
  title: 'Software Engineer at Acme',
  company: '',
  message_type: 'Connection Request' as const,
  message_text: '',
  status: 'Sent' as const,
};

function makeRequest(body: unknown) {
  return new Request('http://localhost/functions/v1/linkedin-tracker-webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeDbMock(client: { sheet_id: string } | null) {
  const single = vi
    .fn()
    .mockResolvedValue(
      client ? { data: client, error: null } : { data: null, error: new Error('not found') },
    );
  const eq = vi.fn(() => ({ single }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { from };
}

describe('linkedin-tracker-webhook', () => {
  it('OPTIONS preflight → 204 with CORS headers', async () => {
    const req = new Request('http://localhost/functions/v1/linkedin-tracker-webhook', {
      method: 'OPTIONS',
    });
    const res = await handler(req);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });

  it('POST response includes CORS header', async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeDbMock({ sheet_id: SHEET_ID }) as ReturnType<typeof createAdminClient>,
    );
    const res = await handler(makeRequest(VALID_BODY));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    denoEnvGet.mockImplementation((key: string) => {
      const env: Record<string, string> = {
        SUPABASE_URL: 'http://localhost:54331',
        SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
        GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
          client_email: 'test@project.iam.gserviceaccount.com',
          private_key: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n',
        }),
      };
      return env[key];
    });
  });

  it('valid payload → 200 and row appended with correct values', async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeDbMock({ sheet_id: SHEET_ID }) as ReturnType<typeof createAdminClient>,
    );

    const res = await handler(makeRequest(VALID_BODY));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    const sheets = vi.mocked(createGoogleSheetsClient).mock.results[0].value;
    expect(sheets.appendRow).toHaveBeenCalledWith(SHEET_ID, 'Outreach Log!B:L', [
      '',
      '',
      '',
      'Jane Doe',
      'Software Engineer at Acme',
      '',
      'Connection Request',
      '5/13/2026',
      'Sent',
      '',
      '',
    ]);
  });

  it('unknown api_key → 403', async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeDbMock(null) as ReturnType<typeof createAdminClient>,
    );

    const res = await handler(makeRequest(VALID_BODY));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('ACCESS_DENIED');
  });

  it('missing required field → 400', async () => {
    const res = await handler(makeRequest({ api_key: VALID_API_KEY }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('empty title is accepted → 200', async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeDbMock({ sheet_id: SHEET_ID }) as ReturnType<typeof createAdminClient>,
    );
    const res = await handler(makeRequest({ ...VALID_BODY, title: '' }));
    expect(res.status).toBe(200);
  });

  it('debug field present → logged but not in row array', async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeDbMock({ sheet_id: SHEET_ID }) as ReturnType<typeof createAdminClient>,
    );

    const bodyWithDebug = {
      ...VALID_BODY,
      debug: {
        button_aria_label: 'Send invite',
        button_text: 'Send',
        container_html: '<div>...</div>',
        page_url: 'https://www.linkedin.com/in/test',
      },
    };

    const res = await handler(makeRequest(bodyWithDebug));
    expect(res.status).toBe(200);

    const sheets = vi.mocked(createGoogleSheetsClient).mock.results[0].value;
    const rowArg = sheets.appendRow.mock.calls[0][2] as string[];
    expect(rowArg).toHaveLength(11);
    // debug not in row
    expect(rowArg.join('')).not.toContain('button_aria_label');
  });

  it('profile_url present → written to last column', async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeDbMock({ sheet_id: SHEET_ID }) as ReturnType<typeof createAdminClient>,
    );

    const res = await handler(
      makeRequest({ ...VALID_BODY, profile_url: 'https://www.linkedin.com/in/janedoe/' }),
    );
    expect(res.status).toBe(200);

    const sheets = vi.mocked(createGoogleSheetsClient).mock.results[0].value;
    const rowArg = sheets.appendRow.mock.calls[0][2] as string[];
    expect(rowArg[10]).toBe('https://www.linkedin.com/in/janedoe/');
  });

  it('page_url present → accepted and not written to sheet row', async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeDbMock({ sheet_id: SHEET_ID }) as ReturnType<typeof createAdminClient>,
    );

    const res = await handler(
      makeRequest({
        ...VALID_BODY,
        page_url: 'https://www.linkedin.com/search/results/people/?keywords=oracle',
      }),
    );
    expect(res.status).toBe(200);

    const sheets = vi.mocked(createGoogleSheetsClient).mock.results[0].value;
    const rowArg = sheets.appendRow.mock.calls[0][2] as string[];
    expect(rowArg).toHaveLength(11);
    expect(rowArg.join('')).not.toContain('search/results');
  });

  it('Sheets API throws → 500', async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeDbMock({ sheet_id: SHEET_ID }) as ReturnType<typeof createAdminClient>,
    );

    vi.mocked(createGoogleSheetsClient).mockReturnValue({
      appendRow: vi.fn().mockRejectedValue(new Error('Sheets API append failed 403: Forbidden')),
    });

    const res = await handler(makeRequest(VALID_BODY));
    expect(res.status).toBe(500);
  });
});
