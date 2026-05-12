import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GoogleDriveClient,
  GoogleDriveDeps,
  GoogleDriveEnv,
} from '../../../supabase/functions/_shared/google-drive.ts';

const ENV: GoogleDriveEnv = {
  FRACTIONAL_DRIVE_ID: 'shared-drive-id',
  FRACTIONAL_WORKBOOK_TEMPLATE_ID: 'template-doc-id',
};

function makeDeps(fetchResponse: object = { id: 'result-id' }): GoogleDriveDeps {
  return {
    fetch: vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(fetchResponse),
      text: () => Promise.resolve(''),
    }),
    getToken: vi.fn().mockResolvedValue('test-token'),
  };
}

function errorDeps(status: number): GoogleDriveDeps {
  return {
    fetch: vi.fn().mockResolvedValue({ ok: false, status, text: () => Promise.resolve('Error') }),
    getToken: vi.fn().mockResolvedValue('test-token'),
  };
}

describe('GoogleDriveClient', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('createClientFolder', () => {
    it('returns the new folder ID', async () => {
      const client = new GoogleDriveClient(ENV, makeDeps({ id: 'new-folder-id' }));
      expect(await client.createClientFolder('Jane Doe')).toBe('new-folder-id');
    });

    it('POSTs to /drive/v3/files with supportsAllDrives=true and correct body', async () => {
      const deps = makeDeps({ id: 'new-folder-id' });
      const client = new GoogleDriveClient(ENV, deps);
      await client.createClientFolder('Jane Doe');

      const [url, init] = (deps.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect(url).toContain('/drive/v3/files');
      expect(url).toContain('supportsAllDrives=true');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
      const body = JSON.parse(init.body as string);
      expect(body.name).toBe('Jane Doe — Fractional Advisory');
      expect(body.mimeType).toBe('application/vnd.google-apps.folder');
      expect(body.parents).toContain('shared-drive-id');
    });

    it('throws InternalServiceException on Drive API error', async () => {
      const client = new GoogleDriveClient(ENV, errorDeps(403));
      await expect(client.createClientFolder('Jane Doe')).rejects.toThrow(
        'Drive API POST /files failed 403',
      );
    });
  });

  describe('copyWorkbookTemplate', () => {
    it('returns the new doc ID', async () => {
      const client = new GoogleDriveClient(ENV, makeDeps({ id: 'new-doc-id' }));
      expect(await client.copyWorkbookTemplate('folder-id', 'Jane Doe')).toBe('new-doc-id');
    });

    it('POSTs to the template copy endpoint with correct parent and name', async () => {
      const deps = makeDeps({ id: 'new-doc-id' });
      const client = new GoogleDriveClient(ENV, deps);
      await client.copyWorkbookTemplate('folder-id', 'Jane Doe');

      const [url, init] = (deps.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect(url).toContain('/files/template-doc-id/copy');
      expect(url).toContain('supportsAllDrives=true');
      const body = JSON.parse(init.body as string);
      expect(body.name).toBe('Jane Doe — Fractional Advisory');
      expect(body.parents).toContain('folder-id');
    });
  });

  describe('shareFolder', () => {
    it('POSTs a writer permission with sendNotificationEmail=false', async () => {
      const deps = makeDeps({});
      const client = new GoogleDriveClient(ENV, deps);
      await client.shareFolder('folder-id', 'jane@example.com');

      const [url, init] = (deps.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect(url).toContain('/files/folder-id/permissions');
      expect(url).toContain('sendNotificationEmail=false');
      const body = JSON.parse(init.body as string);
      expect(body.role).toBe('writer');
      expect(body.type).toBe('user');
      expect(body.emailAddress).toBe('jane@example.com');
    });

    it('throws on Drive API error', async () => {
      const client = new GoogleDriveClient(ENV, errorDeps(400));
      await expect(client.shareFolder('folder-id', 'jane@example.com')).rejects.toThrow(
        'Drive API POST',
      );
    });
  });

  describe('token caching', () => {
    it('fetches the token only once across multiple operations', async () => {
      const getToken = vi.fn().mockResolvedValue('test-token');
      const deps: GoogleDriveDeps = {
        fetch: vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ id: 'x' }),
          text: () => Promise.resolve(''),
        }),
        getToken,
      };
      const client = new GoogleDriveClient(ENV, deps);

      await client.createClientFolder('Jane Doe');
      await client.copyWorkbookTemplate('folder-id', 'Jane Doe');
      await client.shareFolder('folder-id', 'jane@example.com');

      expect(getToken).toHaveBeenCalledTimes(1);
    });
  });
});
