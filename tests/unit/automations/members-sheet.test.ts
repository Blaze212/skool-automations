import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SkoolMember } from '../../../automations/shared/skool/types.js';

const mockGet = vi.fn();
const mockBatchUpdate = vi.fn();
const mockAppend = vi.fn();

vi.mock('googleapis', () => ({
  google: {
    auth: {
      GoogleAuth: class {},
    },
    sheets: vi.fn().mockReturnValue({
      spreadsheets: {
        values: {
          get: mockGet,
          batchUpdate: mockBatchUpdate,
          append: mockAppend,
        },
      },
    }),
  },
}));

const SERVICE_ACCOUNT_KEY = JSON.stringify({ type: 'service_account' });
const SKOOL_FREE_MEMBER_SYNC_SHEET_ID = 'test-sheet-id';

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
];

function member(overrides: Partial<SkoolMember> = {}): SkoolMember {
  return {
    skoolId: 'id-1',
    name: 'Jane Doe',
    joinDate: '2024-01-01T00:00:00Z',
    lastLoginDate: '2024-06-01T00:00:00Z',
    email: 'jane@example.com',
    currentSituation: 'Employed',
    mainGoal: 'New role',
    ...overrides,
  };
}

describe('MembersSheet.upsertMembers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBatchUpdate.mockResolvedValue({});
    mockAppend.mockResolvedValue({});
  });

  it('appends a new member when skoolId not found', async () => {
    mockGet.mockResolvedValue({ data: { values: [HEADER_ROW] } });

    const { MembersSheet } = await import('../../../automations/free-member-sync/members-sheet.js');
    const sheet = new MembersSheet(SERVICE_ACCOUNT_KEY, SKOOL_FREE_MEMBER_SYNC_SHEET_ID);
    const result = await sheet.upsertMembers([member()]);

    expect(result.inserted).toBe(1);
    expect(result.updated).toBe(0);
    expect(mockAppend).toHaveBeenCalledOnce();
    expect(mockBatchUpdate).not.toHaveBeenCalled();
  });

  it('updates existing member without overwriting email when already present', async () => {
    const existingRow = [
      'Old Name',
      'id-1',
      '2023-01-01',
      '',
      '',
      '',
      'zapier@example.com',
      'Y',
      'Y',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
    ];
    mockGet.mockResolvedValue({ data: { values: [HEADER_ROW, existingRow] } });

    const { MembersSheet } = await import('../../../automations/free-member-sync/members-sheet.js');
    const sheet = new MembersSheet(SERVICE_ACCOUNT_KEY, SKOOL_FREE_MEMBER_SYNC_SHEET_ID);
    const result = await sheet.upsertMembers([member()]);

    expect(result.updated).toBe(1);
    expect(result.inserted).toBe(0);
    expect(mockBatchUpdate).toHaveBeenCalledOnce();

    const call = mockBatchUpdate.mock.calls[0] as [
      { requestBody: { data: Array<{ values: (string | undefined)[][] }> } },
    ];
    expect(call[0].requestBody.data[0]?.values[0]?.[6]).toBeUndefined();
  });

  it('writes email when slot is empty', async () => {
    const existingRow = [
      'Old Name',
      'id-1',
      '2023-01-01',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
    ];
    mockGet.mockResolvedValue({ data: { values: [HEADER_ROW, existingRow] } });

    const { MembersSheet } = await import('../../../automations/free-member-sync/members-sheet.js');
    const sheet = new MembersSheet(SERVICE_ACCOUNT_KEY, SKOOL_FREE_MEMBER_SYNC_SHEET_ID);
    await sheet.upsertMembers([member({ email: 'jane@example.com' })]);

    const call = mockBatchUpdate.mock.calls[0] as [
      { requestBody: { data: Array<{ values: (string | undefined)[][] }> } },
    ];
    expect(call[0].requestBody.data[0]?.values[0]?.[6]).toBe('jane@example.com');
  });
});

describe('MembersSheet.appendSyncLog', () => {
  it('appends a row to Sync Log tab', async () => {
    mockAppend.mockResolvedValue({});

    const { MembersSheet } = await import('../../../automations/free-member-sync/members-sheet.js');
    const sheet = new MembersSheet(SERVICE_ACCOUNT_KEY, SKOOL_FREE_MEMBER_SYNC_SHEET_ID);
    await sheet.appendSyncLog({
      timestamp: '2024-06-01T06:00:00Z',
      event: 'skool-sync',
      status: 'success',
      detail: '100 members fetched',
    });

    expect(mockAppend).toHaveBeenCalledWith(
      expect.objectContaining({
        range: 'Sync Log!A:D',
        requestBody: {
          values: [['2024-06-01T06:00:00Z', 'skool-sync', 'success', '100 members fetched']],
        },
      }),
    );
  });
});
