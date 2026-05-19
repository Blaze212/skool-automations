import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSpreadsheetsBatchUpdate = vi.fn();
const mockValuesUpdate = vi.fn();

vi.mock('googleapis', () => ({
  google: {
    auth: {
      GoogleAuth: class {},
    },
    sheets: vi.fn().mockReturnValue({
      spreadsheets: {
        batchUpdate: mockSpreadsheetsBatchUpdate,
        values: {
          update: mockValuesUpdate,
        },
      },
    }),
  },
}));

const SERVICE_ACCOUNT_KEY = JSON.stringify({ type: 'service_account' });
const SHEET_ID = 'test-sheet-id';

const BASE_ROW = {
  date: '2026-05-19',
  screenshotLink: 'https://drive.google.com/file/d/abc123/view?usp=sharing',
  redactedLink: 'https://drive.google.com/file/d/def456/view?usp=sharing',
  svgLink: 'https://drive.google.com/file/d/ghi789/view?usp=sharing',
  area: 'Outreach',
  level: 'IC',
  function: 'Program',
  status: 'Laid off',
  trigger: 'Received layoff notice',
  behavior: '- Updated resume\n- Sent 20 outreach messages',
  outcome: '- Got 3 interviews\n- Accepted offer',
  friction: 'Fear of rejection',
  artifacts: 'Cold outreach template',
  mainObjection: 'Cold outreach does not work',
};

describe('ProofLogSheet.insertRowAtTop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpreadsheetsBatchUpdate.mockResolvedValue({});
    mockValuesUpdate.mockResolvedValue({});
  });

  it('calls spreadsheets.batchUpdate with insertDimension at index 1, sheetId 0', async () => {
    const { ProofLogSheet } = await import('../../../../automations/proof-log/proof-log-sheet.js');
    const sheet = new ProofLogSheet(SERVICE_ACCOUNT_KEY, SHEET_ID);
    await sheet.insertRowAtTop(BASE_ROW);

    expect(mockSpreadsheetsBatchUpdate).toHaveBeenCalledOnce();
    const call = mockSpreadsheetsBatchUpdate.mock.calls[0] as [
      {
        requestBody: {
          requests: Array<{
            insertDimension: {
              range: { sheetId: number; startIndex: number; endIndex: number; dimension: string };
              inheritFromBefore: boolean;
            };
          }>;
        };
      },
    ];
    const insertDim = call[0].requestBody.requests[0]?.insertDimension;
    expect(insertDim?.range.sheetId).toBe(0);
    expect(insertDim?.range.startIndex).toBe(1);
    expect(insertDim?.range.endIndex).toBe(2);
    expect(insertDim?.range.dimension).toBe('ROWS');
    expect(insertDim?.inheritFromBefore).toBe(false);
  });

  it('writes columns B, C, D as =HYPERLINK(...) formulas', async () => {
    const { ProofLogSheet } = await import('../../../../automations/proof-log/proof-log-sheet.js');
    const sheet = new ProofLogSheet(SERVICE_ACCOUNT_KEY, SHEET_ID);
    await sheet.insertRowAtTop(BASE_ROW);

    expect(mockValuesUpdate).toHaveBeenCalledOnce();
    const call = mockValuesUpdate.mock.calls[0] as [
      { requestBody: { values: string[][] }; valueInputOption: string },
    ];
    const row = call[0].requestBody.values[0];
    expect(row?.[1]).toMatch(/^=HYPERLINK\("/);
    expect(row?.[1]).toContain(BASE_ROW.screenshotLink);
    expect(row?.[2]).toMatch(/^=HYPERLINK\("/);
    expect(row?.[2]).toContain(BASE_ROW.redactedLink);
    expect(row?.[3]).toMatch(/^=HYPERLINK\("/);
    expect(row?.[3]).toContain(BASE_ROW.svgLink);
  });

  it('uses USER_ENTERED valueInputOption so Sheets evaluates formulas', async () => {
    const { ProofLogSheet } = await import('../../../../automations/proof-log/proof-log-sheet.js');
    const sheet = new ProofLogSheet(SERVICE_ACCOUNT_KEY, SHEET_ID);
    await sheet.insertRowAtTop(BASE_ROW);

    const call = mockValuesUpdate.mock.calls[0] as [{ valueInputOption: string }];
    expect(call[0].valueInputOption).toBe('USER_ENTERED');
  });

  it('writes all 14 fields in column order A–N', async () => {
    const { ProofLogSheet } = await import('../../../../automations/proof-log/proof-log-sheet.js');
    const sheet = new ProofLogSheet(SERVICE_ACCOUNT_KEY, SHEET_ID);
    await sheet.insertRowAtTop(BASE_ROW);

    const call = mockValuesUpdate.mock.calls[0] as [
      { range: string; requestBody: { values: string[][] } },
    ];
    const row = call[0].requestBody.values[0];
    expect(row).toHaveLength(14);
    expect(row?.[0]).toBe(BASE_ROW.date); // A: date
    expect(row?.[4]).toBe(BASE_ROW.area); // E: area
    expect(row?.[5]).toBe(BASE_ROW.level); // F: level
    expect(row?.[6]).toBe(BASE_ROW.function); // G: function
    expect(row?.[7]).toBe(BASE_ROW.status); // H: status
    expect(row?.[8]).toBe(BASE_ROW.trigger); // I: trigger
    expect(row?.[9]).toBe(BASE_ROW.behavior); // J: behavior
    expect(row?.[10]).toBe(BASE_ROW.outcome); // K: outcome
    expect(row?.[11]).toBe(BASE_ROW.friction); // L: friction
    expect(row?.[12]).toBe(BASE_ROW.artifacts); // M: artifacts
    expect(row?.[13]).toBe(BASE_ROW.mainObjection); // N: mainObjection
    expect(call[0].range).toBe('A2:N2');
  });
});
