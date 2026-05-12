import { getGoogleAccessToken } from './google-auth.ts';
import { InternalServiceException } from './errors.ts';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';

async function drivePost(
  path: string,
  body: Record<string, unknown>,
  token: string,
  extraParams?: Record<string, string>,
): Promise<Record<string, string>> {
  const url = new URL(`${DRIVE_API}${path}`);
  url.searchParams.set('supportsAllDrives', 'true');
  if (extraParams) {
    for (const [k, v] of Object.entries(extraParams)) url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new InternalServiceException({ message: `Drive API error ${res.status}: ${text}` });
  }

  return res.json() as Promise<Record<string, string>>;
}

export async function createClientFolder(clientName: string): Promise<string> {
  const driveId = Deno.env.get('FRACTIONAL_DRIVE_ID');
  if (!driveId) throw new InternalServiceException({ message: 'FRACTIONAL_DRIVE_ID not set' });

  const token = await getGoogleAccessToken(DRIVE_SCOPE);

  const data = await drivePost(
    '/files',
    {
      name: `${clientName} — Fractional Advisory`,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [driveId],
    },
    token,
  );

  return data.id;
}

export async function copyWorkbookTemplate(folderId: string, clientName: string): Promise<string> {
  const templateId = Deno.env.get('FRACTIONAL_WORKBOOK_TEMPLATE_ID');
  if (!templateId) {
    throw new InternalServiceException({ message: 'FRACTIONAL_WORKBOOK_TEMPLATE_ID not set' });
  }

  const token = await getGoogleAccessToken(DRIVE_SCOPE);

  const data = await drivePost(
    `/files/${templateId}/copy`,
    {
      name: `${clientName} — Fractional Advisory`,
      parents: [folderId],
    },
    token,
  );

  return data.id;
}

export async function shareFolder(folderId: string, email: string): Promise<void> {
  const token = await getGoogleAccessToken(DRIVE_SCOPE);

  await drivePost(
    `/files/${folderId}/permissions`,
    { role: 'writer', type: 'user', emailAddress: email },
    token,
    { sendNotificationEmail: 'false' },
  );
}
