import type pino from 'pino';
import { SheetsClient } from '../shared/google/sheets-client.js';
import type { SkoolMember } from '../shared/skool/types.js';

const MEMBERS_SHEET = 'Members';
const SYNC_LOG_SHEET = 'Sync Log';

const HEADER_ROW = [
  'Name',
  'Skool Id',
  'Join Date',
  'Last Login Date',
  'Current Situation',
  'Main Goal',
  'Email',
  'Roadmap',
  'Target Role',
  'Resume',
  'LinkedIn',
  'Community',
  'DM/Email Response',
  'Activation Score',
  'Health Bucket',
  'Purchase/Scholarship',
  'First Message',
  'Notes',
] as const;

export interface SyncLogEntry {
  timestamp: string;
  event: string;
  status: 'success' | 'error' | 'warning';
  detail: string;
}

export interface UpsertResult {
  inserted: number;
  updated: number;
  nameMatched: number; // rows matched by name when Skool ID was missing
}

function colIndex(header: (typeof HEADER_ROW)[number]): number {
  return HEADER_ROW.indexOf(header);
}

const SHEETS_EPOCH = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function formatDate(iso: string): number {
  return (new Date(iso).getTime() - SHEETS_EPOCH) / MS_PER_DAY;
}

export class MembersSheet {
  private client: SheetsClient;

  constructor(serviceAccountKey: string, spreadsheetId: string) {
    this.client = new SheetsClient(serviceAccountKey, spreadsheetId);
  }

  headers(): typeof HEADER_ROW {
    return HEADER_ROW;
  }

  async ensureSheets(): Promise<{ membersSheetId: number }> {
    const { created: membersCreated, sheetId: membersSheetId } =
      await this.client.ensureSheetExists(MEMBERS_SHEET);
    await this.client.ensureSheetExists(SYNC_LOG_SHEET);
    if (membersCreated) {
      await this.client.appendRows(`${MEMBERS_SHEET}!A1`, [Array.from(HEADER_ROW)]);
    }
    // Join Date = col C (index 2), Last Login Date = col D (index 3)
    await this.client.setColumnNumberFormat(membersSheetId, 2, 4, 'MMMM D');
    return { membersSheetId };
  }

  async upsertMembers(members: SkoolMember[], log?: pino.Logger): Promise<UpsertResult> {
    const { membersSheetId } = await this.ensureSheets();
    const rows = await this.client.readRange(`${MEMBERS_SHEET}!A:R`);

    const skoolIdCol = colIndex('Skool Id');
    const emailCol = colIndex('Email');
    const actScoreCol = colIndex('Activation Score');
    const healthBucketCol = colIndex('Health Bucket');

    const nameCol = colIndex('Name');
    const existingById = new Map<string, number>();
    const existingByName = new Map<string, number>(); // normalized name → row number, only for rows with empty Skool ID
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (row === undefined) continue;
      const id = row[skoolIdCol] as string | undefined;
      if (id) {
        existingById.set(id, i + 1);
      } else {
        const name = (row[nameCol] as string | undefined)?.trim().toLowerCase();
        if (name) existingByName.set(name, i + 1);
      }
    }

    const updates: { range: string; values: (string | number | undefined)[][] }[] = [];
    const newRows: (string | number)[][] = [];
    let inserted = 0;
    let updated = 0;
    let nameMatched = 0;

    for (const member of members) {
      let existingRowNum = existingById.get(member.skoolId);
      if (existingRowNum === undefined) {
        const nameKey = member.name.trim().toLowerCase();
        const nameRow = existingByName.get(nameKey);
        if (nameRow !== undefined) {
          existingRowNum = nameRow;
          existingByName.delete(nameKey); // prevent a second member with the same name claiming this row
          existingById.set(member.skoolId, existingRowNum); // prevent same Skool ID re-appearing on a later page from appending
          nameMatched++;
          log?.info(
            { name: member.name, skoolId: member.skoolId, row: existingRowNum },
            'name-matched — backfilling Skool ID',
          );
        }
      }

      if (existingRowNum !== undefined) {
        const existingRow = rows[existingRowNum - 1] ?? [];
        const currentEmail = existingRow[emailCol] as string | undefined;
        // Never overwrite email if Zapier already set it
        const emailValue = currentEmail ? undefined : member.email;

        updates.push({
          range: `${MEMBERS_SHEET}!A${existingRowNum}:G${existingRowNum}`,
          values: [
            [
              member.name,
              member.skoolId,
              formatDate(member.joinDate),
              formatDate(member.lastLoginDate),
              member.currentSituation,
              member.mainGoal,
              emailValue,
            ],
          ],
        });
        updated++;
      } else {
        const newRow: (string | number)[] = new Array(HEADER_ROW.length).fill('') as string[];
        newRow[colIndex('Name')] = member.name;
        newRow[colIndex('Skool Id')] = member.skoolId;
        newRow[colIndex('Join Date')] = formatDate(member.joinDate);
        newRow[colIndex('Last Login Date')] = formatDate(member.lastLoginDate);
        newRow[colIndex('Current Situation')] = member.currentSituation;
        newRow[colIndex('Main Goal')] = member.mainGoal;
        newRow[colIndex('Email')] = member.email;
        // New rows are inserted at the top (row 2), so row number = 2 + current newRows.length
        const rowNum = 2 + newRows.length;
        newRow[actScoreCol] = `=COUNTIF(H${rowNum}:M${rowNum},"Y")`;
        newRow[healthBucketCol] =
          `=IF(ISBLANK(D${rowNum}),"",IF(AND(N${rowNum}>=3,TODAY()-D${rowNum}<=3),"Green",IF(AND(N${rowNum}>=1,N${rowNum}<=2,TODAY()-D${rowNum}<=7),"Yellow","Red")))`;
        newRows.push(newRow);
        inserted++;
      }
    }

    await this.client.batchUpdate(updates);
    if (newRows.length > 0) {
      // Insert blank rows just below the header, then fill them in one write
      await this.client.insertRows(membersSheetId, 1, newRows.length);
      await this.client.batchUpdate(
        [{ range: `${MEMBERS_SHEET}!A2:R${1 + newRows.length}`, values: newRows }],
        'USER_ENTERED',
      );
    }

    return { inserted, updated, nameMatched };
  }

  async readAllMembers(): Promise<string[][]> {
    const rows = await this.client.readRange(`${MEMBERS_SHEET}!A:R`);
    return rows.slice(1);
  }

  async appendSyncLog(entry: SyncLogEntry): Promise<void> {
    await this.client.appendRows(`${SYNC_LOG_SHEET}!A:D`, [
      [entry.timestamp, entry.event, entry.status, entry.detail],
    ]);
  }
}
