import { google } from 'googleapis';
import { getGoogleAuth, Scopes } from './auth.js';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
}

export interface UploadResult {
  id: string;
  webViewLink: string;
}

export class DriveClient {
  private drive;

  constructor(serviceAccountKey: string) {
    const auth = getGoogleAuth(serviceAccountKey, [Scopes.DRIVE]);
    this.drive = google.drive({ version: 'v3', auth });
  }

  async listFiles(options?: { folderId?: string; mimeType?: string }): Promise<DriveFile[]> {
    const q: string[] = ['trashed = false'];
    if (options?.folderId) q.push(`'${options.folderId}' in parents`);
    if (options?.mimeType) q.push(`mimeType = '${options.mimeType}'`);

    const res = await this.drive.files.list({
      q: q.join(' and '),
      fields: 'files(id, name, mimeType, modifiedTime)',
    });

    return (res.data.files ?? []) as DriveFile[];
  }

  async uploadFile(options: {
    name: string;
    folderId?: string;
    mimeType: string;
    content: Buffer | string;
  }): Promise<UploadResult> {
    const { Readable } = await import('node:stream');
    const body =
      typeof options.content === 'string'
        ? Readable.from([options.content])
        : Readable.from(options.content);

    const res = await this.drive.files.create({
      requestBody: {
        name: options.name,
        mimeType: options.mimeType,
        ...(options.folderId ? { parents: [options.folderId] } : {}),
      },
      media: { mimeType: options.mimeType, body },
      fields: 'id, webViewLink',
      supportsAllDrives: true,
    });

    const id = res.data.id;
    const webViewLink = res.data.webViewLink;
    if (!id || !webViewLink) throw new Error('Drive upload returned no id or webViewLink');
    return { id, webViewLink };
  }

  async createFolder(options: { name: string; parentId?: string }): Promise<string> {
    const res = await this.drive.files.create({
      requestBody: {
        name: options.name,
        mimeType: 'application/vnd.google-apps.folder',
        ...(options.parentId ? { parents: [options.parentId] } : {}),
      },
      fields: 'id',
    });
    const id = res.data.id;
    if (!id) throw new Error(`Failed to create folder: ${options.name}`);
    return id;
  }

  async downloadFile(fileId: string): Promise<Buffer> {
    const res = await this.drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'arraybuffer' },
    );
    return Buffer.from(res.data as ArrayBuffer);
  }
}
