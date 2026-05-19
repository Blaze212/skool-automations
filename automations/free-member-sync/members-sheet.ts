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

  async ensureSheets(): Promise<void> {
    const { created: membersCreated, sheetId } = await this.client.ensureSheetExists(MEMBERS_SHEET);
    await this.client.ensureSheetExists(SYNC_LOG_SHEET);
    if (membersCreated) {
      await this.client.appendRows(`${MEMBERS_SHEET}!A1`, [Array.from(HEADER_ROW)]);
    }
    // Join Date = col C (index 2), Last Login Date = col D (index 3)
    await this.client.setColumnNumberFormat(sheetId, 2, 4, 'MMMM D');
  }

  async upsertMembers(members: SkoolMember[]): Promise<UpsertResult> {
    await this.ensureSheets();
    const rows = await this.client.readRange(`${MEMBERS_SHEET}!A:R`);

    const skoolIdCol = colIndex('Skool Id');
    const emailCol = colIndex('Email');

    const existingById = new Map<string, number>();
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (row === undefined) continue;
      const id = row[skoolIdCol] as string | undefined;
      if (id) existingById.set(id, i + 1);
    }

    const updates: { range: string; values: (string | number | undefined)[][] }[] = [];
    const appends: (string | number)[][] = [];
    let inserted = 0;
    let updated = 0;

    for (const member of members) {
      const existingRowNum = existingById.get(member.skoolId);

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
        appends.push(newRow);
        inserted++;
      }
    }

    await this.client.batchUpdate(updates);
    if (appends.length > 0) {
      await this.client.appendRows(`${MEMBERS_SHEET}!A:R`, appends);
    }

    return { inserted, updated };
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
