import { defaultGoogleAuthDeps, getGoogleAccessToken, loadGoogleAuthEnv } from './google-auth.ts';
import { InternalServiceException } from './errors.ts';

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const SHEETS_API = 'https://sheets.googleapis.com/v4';

export interface GoogleSheetsDeps {
  fetch: typeof globalThis.fetch;
  getToken: (scope: string) => Promise<string>;
}

export function defaultGoogleSheetsDeps(): GoogleSheetsDeps {
  const authEnv = loadGoogleAuthEnv();
  const authDeps = defaultGoogleAuthDeps();
  return {
    fetch: globalThis.fetch,
    getToken: (scope) => getGoogleAccessToken(scope, authEnv, authDeps),
  };
}

export class GoogleSheetsClient {
  private _token: Promise<string> | null = null;

  constructor(private readonly deps: GoogleSheetsDeps) {}

  private token(): Promise<string> {
    this._token ??= this.deps.getToken(SHEETS_SCOPE);
    return this._token;
  }

  async appendRow(sheetId: string, range: string, values: string[]): Promise<void> {
    const token = await this.token();
    const url = new URL(
      `${SHEETS_API}/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}:append`,
    );
    url.searchParams.set('valueInputOption', 'USER_ENTERED');

    const res = await this.deps.fetch(url.toString(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [values] }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new InternalServiceException({
        message: `Sheets API append failed ${res.status}: ${text}`,
      });
    }
  }
}

export function createGoogleSheetsClient(
  deps: GoogleSheetsDeps = defaultGoogleSheetsDeps(),
): GoogleSheetsClient {
  return new GoogleSheetsClient(deps);
}
