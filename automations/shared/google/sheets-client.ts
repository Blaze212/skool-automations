import { google } from 'googleapis';
import { getGoogleAuth, Scopes } from './auth.js';

export class SheetsClient {
  private sheets;
  readonly spreadsheetId: string;

  constructor(serviceAccountKey: string, spreadsheetId: string) {
    const auth = getGoogleAuth(serviceAccountKey, [Scopes.SHEETS]);
    this.sheets = google.sheets({ version: 'v4', auth });
    this.spreadsheetId = spreadsheetId;
  }

  async readRange(range: string): Promise<string[][]> {
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range,
    });
    return (response.data.values ?? []) as string[][];
  }

  async appendRows(range: string, rows: (string | number | undefined)[][]): Promise<void> {
    await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range,
      valueInputOption: 'RAW',
      requestBody: { values: rows },
    });
  }

  async batchUpdate(
    updates: { range: string; values: (string | number | undefined)[][] }[],
  ): Promise<void> {
    if (updates.length === 0) return;
    await this.sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data: updates },
    });
  }

  async insertRows(sheetId: number, startRowIndex: number, count: number): Promise<void> {
    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        requests: [
          {
            insertDimension: {
              range: {
                sheetId,
                dimension: 'ROWS',
                startIndex: startRowIndex,
                endIndex: startRowIndex + count,
              },
              inheritFromBefore: false,
            },
          },
        ],
      },
    });
  }

  async ensureSheetExists(sheetName: string): Promise<{ created: boolean; sheetId: number }> {
    const meta = await this.sheets.spreadsheets.get({ spreadsheetId: this.spreadsheetId });
    const existing = meta.data.sheets?.find((s) => s.properties?.title === sheetName);
    if (existing) {
      return { created: false, sheetId: existing.properties?.sheetId ?? 0 };
    }
    const res = await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
    });
    const sheetId = res.data.replies?.[0]?.addSheet?.properties?.sheetId ?? 0;
    return { created: true, sheetId };
  }

  async setColumnNumberFormat(
    sheetId: number,
    startColIndex: number,
    endColIndex: number,
    pattern: string,
  ): Promise<void> {
    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        requests: [
          {
            repeatCell: {
              range: {
                sheetId,
                startRowIndex: 1, // skip header
                startColumnIndex: startColIndex,
                endColumnIndex: endColIndex,
              },
              cell: {
                userEnteredFormat: {
                  numberFormat: { type: 'DATE_TIME', pattern },
                },
              },
              fields: 'userEnteredFormat.numberFormat',
            },
          },
        ],
      },
    });
  }
}
