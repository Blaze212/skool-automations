import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const SESSION_COOKIE = 'test-session-token-abc';
const BUILD_ID = 'abc123buildId';
const MEMBERS_HTML = `<html><script id="__NEXT_DATA__">{"buildId":"${BUILD_ID}"}</script></html>`;

function makeMember(overrides: Record<string, unknown> = {}) {
  return {
    id: 'skool-id-1',
    firstName: 'Jane',
    lastName: 'Doe',
    email: '',
    metadata: { bio: '', lastOffline: 0 },
    createdAt: '2024-01-15T00:00:00Z',
    member: {
      id: 'member-id-1',
      createdAt: '2024-01-15T00:00:00Z',
      lastOffline: '2024-06-01T00:00:00Z',
      role: 'member',
      metadata: {
        survey: JSON.stringify({
          survey: [
            { question: 'What best describes your current situation?', answer: 'Employed' },
            { question: "What's the main goal in the next 6–12 months?", answer: 'New role' },
            { question: "What's your email address?", answer: 'jane@example.com' },
          ],
        }),
      },
    },
    ...overrides,
  };
}

function membersPageResponse(members: ReturnType<typeof makeMember>[], totalPages: number) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        pageProps: {
          renderData: { members },
          totalPages,
          itemsPerPage: 30,
        },
      }),
  };
}

function htmlResponse() {
  return { ok: true, text: () => Promise.resolve(MEMBERS_HTML) };
}

describe('fetchAllMembers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns members from a single page', async () => {
    mockFetch
      .mockResolvedValueOnce(htmlResponse())
      .mockResolvedValueOnce(membersPageResponse([makeMember()], 1));

    const { fetchAllMembers } = await import('../../../automations/shared/skool/members-api.js');
    const members = await fetchAllMembers({ group: 'career-systems', cookies: SESSION_COOKIE });

    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({
      skoolId: 'skool-id-1',
      name: 'Jane Doe',
      email: 'jane@example.com',
      currentSituation: 'Employed',
      mainGoal: 'New role',
    });
  });

  it('paginates across multiple pages', async () => {
    const m1 = makeMember({ id: 'id-1' });
    const m2 = makeMember({ id: 'id-2', firstName: 'Bob', lastName: 'Smith' });

    mockFetch
      .mockResolvedValueOnce(htmlResponse())
      .mockResolvedValueOnce(membersPageResponse([m1], 2))
      .mockResolvedValueOnce(membersPageResponse([m2], 2));

    const { fetchAllMembers } = await import('../../../automations/shared/skool/members-api.js');
    const members = await fetchAllMembers({ group: 'career-systems', cookies: SESSION_COOKIE });

    expect(members).toHaveLength(2);
    expect(members[0]?.skoolId).toBe('id-1');
    expect(members[1]?.skoolId).toBe('id-2');
  });

  it('passes session cookie to HTML fetch', async () => {
    mockFetch
      .mockResolvedValueOnce(htmlResponse())
      .mockResolvedValueOnce(membersPageResponse([], 1));

    const { fetchAllMembers } = await import('../../../automations/shared/skool/members-api.js');
    await fetchAllMembers({ group: 'career-systems', cookies: SESSION_COOKIE });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init?.headers as Record<string, string>)?.['Cookie']).toBe(SESSION_COOKIE);
  });

  it('throws when HTML fetch fails', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });

    const { fetchAllMembers } = await import('../../../automations/shared/skool/members-api.js');
    await expect(
      fetchAllMembers({ group: 'career-systems', cookies: SESSION_COOKIE }),
    ).rejects.toThrow('Members page fetch failed: 403');
  });

  it('handles missing survey fields gracefully', async () => {
    const m = makeMember();
    (m.member as Record<string, unknown>)['metadata'] = undefined;

    mockFetch
      .mockResolvedValueOnce(htmlResponse())
      .mockResolvedValueOnce(membersPageResponse([m as ReturnType<typeof makeMember>], 1));

    const { fetchAllMembers } = await import('../../../automations/shared/skool/members-api.js');
    const members = await fetchAllMembers({ group: 'career-systems', cookies: SESSION_COOKIE });
    expect(members[0]?.currentSituation).toBe('');
    expect(members[0]?.mainGoal).toBe('');
  });
});
