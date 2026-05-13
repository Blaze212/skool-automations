import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GoogleSheetsClient,
  GoogleSheetsDeps,
} from '../../../supabase/functions/_shared/google-sheets.ts';

function makeDeps(): GoogleSheetsDeps {
  return {
    fetch: vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(''),
    }),
    getToken: vi.fn().mockResolvedValue('test-token'),
  };
}

function errorDeps(status: number): GoogleSheetsDeps {
  return {
    fetch: vi.fn().mockResolvedValue({ ok: false, status, text: () => Promise.resolve('Error') }),
    getToken: vi.fn().mockResolvedValue('test-token'),
  };
}

describe('GoogleSheetsClient', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('appendRow', () => {
    it('happy path: POSTs to the correct Sheets API URL', async () => {
      const deps = makeDeps();
      const client = new GoogleSheetsClient(deps);
      await client.appendRow('sheet-id-123', 'Outreach Log!A:K', ['', '', 'Jane', 'Engineer']);

      const [url, init] = (deps.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect(url).toContain('/spreadsheets/sheet-id-123/values/');
      expect(url).toContain(':append');
      expect(url).toContain('valueInputOption=USER_ENTERED');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
      const body = JSON.parse(init.body as string);
      expect(body.values).toEqual([['', '', 'Jane', 'Engineer']]);
    });

    it('throws InternalServiceException on non-200 response', async () => {
      const client = new GoogleSheetsClient(errorDeps(403));
      await expect(client.appendRow('sheet-id-123', 'Outreach Log!A:K', ['val'])).rejects.toThrow(
        'Sheets API append failed 403',
      );
    });

    it('fetches token only once across multiple calls', async () => {
      const getToken = vi.fn().mockResolvedValue('test-token');
      const deps: GoogleSheetsDeps = {
        fetch: vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve('') }),
        getToken,
      };
      const client = new GoogleSheetsClient(deps);
      await client.appendRow('sheet-id', 'Sheet1!A:B', ['a', 'b']);
      await client.appendRow('sheet-id', 'Sheet1!A:B', ['c', 'd']);
      expect(getToken).toHaveBeenCalledTimes(1);
    });
  });
});
