import { defaultGoogleAuthDeps, getGoogleAccessToken, loadGoogleAuthEnv } from './google-auth.ts';
import { InternalServiceException } from './errors.ts';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';

export interface GoogleDriveEnv {
  FRACTIONAL_DRIVE_ID: string;
  FRACTIONAL_WORKBOOK_TEMPLATE_ID: string;
}

export interface GoogleDriveDeps {
  fetch: typeof globalThis.fetch;
  getToken: (scope: string) => Promise<string>;
}

export function loadGoogleDriveEnv(): GoogleDriveEnv {
  const driveId = Deno.env.get('FRACTIONAL_DRIVE_ID');
  const templateId = Deno.env.get('FRACTIONAL_WORKBOOK_TEMPLATE_ID');
  if (!driveId) throw new InternalServiceException({ message: 'FRACTIONAL_DRIVE_ID not set' });
  if (!templateId) {
    throw new InternalServiceException({ message: 'FRACTIONAL_WORKBOOK_TEMPLATE_ID not set' });
  }
  return { FRACTIONAL_DRIVE_ID: driveId, FRACTIONAL_WORKBOOK_TEMPLATE_ID: templateId };
}

export function defaultGoogleDriveDeps(): GoogleDriveDeps {
  const authEnv = loadGoogleAuthEnv();
  const authDeps = defaultGoogleAuthDeps();
  return {
    fetch: globalThis.fetch,
    getToken: (scope) => getGoogleAccessToken(scope, authEnv, authDeps),
  };
}

export class GoogleDriveClient {
  // Token is fetched once and reused for the lifetime of this client instance.
  private _token: Promise<string> | null = null;

  constructor(
    private readonly env: GoogleDriveEnv,
    private readonly deps: GoogleDriveDeps,
  ) {}

  private token(): Promise<string> {
    this._token ??= this.deps.getToken(DRIVE_SCOPE);
    return this._token;
  }

  private async post(
    path: string,
    body: Record<string, unknown>,
    params: Record<string, string> = {},
  ): Promise<Record<string, string>> {
    const token = await this.token();
    const url = new URL(`${DRIVE_API}${path}`);
    url.searchParams.set('supportsAllDrives', 'true');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const res = await this.deps.fetch(url.toString(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new InternalServiceException({
        message: `Drive API POST ${path} failed ${res.status}: ${text}`,
      });
    }

    return res.json() as Promise<Record<string, string>>;
  }

  async createClientFolder(clientName: string): Promise<string> {
    const data = await this.post('/files', {
      name: `${clientName} — Fractional Advisory`,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [this.env.FRACTIONAL_DRIVE_ID],
    });
    return data.id;
  }

  async copyWorkbookTemplate(folderId: string, clientName: string): Promise<string> {
    const data = await this.post(`/files/${this.env.FRACTIONAL_WORKBOOK_TEMPLATE_ID}/copy`, {
      name: `${clientName} — Fractional Advisory`,
      parents: [folderId],
    });
    return data.id;
  }

  async shareFolder(folderId: string, email: string): Promise<void> {
    await this.post(
      `/files/${folderId}/permissions`,
      { role: 'writer', type: 'user', emailAddress: email },
      { sendNotificationEmail: 'false' },
    );
  }
}

export function createGoogleDriveClient(
  env: GoogleDriveEnv = loadGoogleDriveEnv(),
  deps: GoogleDriveDeps = defaultGoogleDriveDeps(),
): GoogleDriveClient {
  return new GoogleDriveClient(env, deps);
}
