import { SheetsClient } from '../shared/google/sheets-client.js';

export interface ProofLogRow {
  date: string;
  screenshotLink: string;
  redactedLink: string;
  finalLink: string;
  area: string;
  level: string;
  function: string;
  status: string;
  trigger: string;
  behavior: string;
  outcome: string;
  friction: string;
  artifacts: string;
  mainObjection: string;
}

function filenameFromUrl(url: string): string {
  const decoded = decodeURIComponent(url);
  const parts = decoded.split('/');
  return parts[parts.length - 1] ?? url;
}

function hyperlink(url: string): string {
  return `=HYPERLINK("${url}","${filenameFromUrl(url)}")`;
}

export class ProofLogSheet extends SheetsClient {
  async insertRowAtTop(row: ProofLogRow): Promise<void> {
    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        requests: [
          {
            insertDimension: {
              range: {
                sheetId: 0,
                dimension: 'ROWS',
                startIndex: 1,
                endIndex: 2,
              },
              inheritFromBefore: false,
            },
          },
        ],
      },
    });

    const values = [
      [
        row.date,
        hyperlink(row.screenshotLink),
        hyperlink(row.redactedLink),
        hyperlink(row.finalLink),
        row.area,
        row.level,
        row.function,
        row.status,
        row.trigger,
        row.behavior,
        row.outcome,
        row.friction,
        row.artifacts,
        row.mainObjection,
      ],
    ];

    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: 'A2:N2',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values },
    });
  }
}
