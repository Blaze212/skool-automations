import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../supabase/functions/_shared/google-auth.ts', () => ({
  getGoogleAccessToken: vi.fn().mockResolvedValue('test-access-token'),
}));

const denoEnvGet = vi.fn();
vi.stubGlobal('Deno', { env: { get: denoEnvGet } });

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  createClientFolder,
  copyWorkbookTemplate,
  shareFolder,
} from '../../../supabase/functions/_shared/drive.ts';

const ENV: Record<string, string> = {
  FRACTIONAL_DRIVE_ID: 'shared-drive-id',
  FRACTIONAL_WORKBOOK_TEMPLATE_ID: 'template-doc-id',
};

describe('createClientFolder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    denoEnvGet.mockImplementation((k: string) => ENV[k]);
  });

  it('returns the new folder ID from the Drive API', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'new-folder-id' }),
    });

    const id = await createClientFolder('Jane Doe');

    expect(id).toBe('new-folder-id');
  });

  it('calls POST /drive/v3/files with correct name and mimeType', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'new-folder-id' }),
    });

    await createClientFolder('Jane Doe');

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/drive/v3/files');
    expect(url).toContain('supportsAllDrives=true');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-access-token' });

    const body = JSON.parse(init.body as string);
    expect(body.name).toBe('Jane Doe — Fractional Advisory');
    expect(body.mimeType).toBe('application/vnd.google-apps.folder');
    expect(body.parents).toContain('shared-drive-id');
  });

  it('throws when FRACTIONAL_DRIVE_ID is not set', async () => {
    denoEnvGet.mockReturnValue(undefined);

    await expect(createClientFolder('Jane Doe')).rejects.toThrow('FRACTIONAL_DRIVE_ID not set');
  });

  it('throws when Drive API returns non-200', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      text: () => Promise.resolve('Forbidden'),
    });

    await expect(createClientFolder('Jane Doe')).rejects.toThrow('Drive API error 403');
  });
});

describe('copyWorkbookTemplate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    denoEnvGet.mockImplementation((k: string) => ENV[k]);
  });

  it('returns the new doc ID from the Drive API', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'new-doc-id' }),
    });

    const id = await copyWorkbookTemplate('folder-id', 'Jane Doe');

    expect(id).toBe('new-doc-id');
  });

  it('calls POST /files/{templateId}/copy with correct name and parent', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'new-doc-id' }),
    });

    await copyWorkbookTemplate('folder-id', 'Jane Doe');

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/files/template-doc-id/copy');
    expect(url).toContain('supportsAllDrives=true');

    const body = JSON.parse(init.body as string);
    expect(body.name).toBe('Jane Doe — Fractional Advisory');
    expect(body.parents).toContain('folder-id');
  });

  it('throws when FRACTIONAL_WORKBOOK_TEMPLATE_ID is not set', async () => {
    denoEnvGet.mockReturnValue(undefined);

    await expect(copyWorkbookTemplate('folder-id', 'Jane')).rejects.toThrow(
      'FRACTIONAL_WORKBOOK_TEMPLATE_ID not set',
    );
  });
});

describe('shareFolder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    denoEnvGet.mockImplementation((k: string) => ENV[k]);
  });

  it('calls POST /files/{folderId}/permissions with writer role', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    await shareFolder('folder-id', 'jane@example.com');

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/files/folder-id/permissions');
    expect(url).toContain('supportsAllDrives=true');
    expect(url).toContain('sendNotificationEmail=false');

    const body = JSON.parse(init.body as string);
    expect(body.role).toBe('writer');
    expect(body.type).toBe('user');
    expect(body.emailAddress).toBe('jane@example.com');
  });

  it('throws when Drive API returns non-200', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve('Bad Request'),
    });

    await expect(shareFolder('folder-id', 'jane@example.com')).rejects.toThrow(
      'Drive API error 400',
    );
  });
});
