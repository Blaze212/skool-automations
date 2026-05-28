import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonOk(body: unknown) {
  return { ok: true, json: () => Promise.resolve(body), text: () => Promise.resolve('') };
}
function deleteOk() {
  return { ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('') };
}

function subscriberRes(id: number) {
  return jsonOk({ subscriber: { id, email_address: 'e@test.com' } });
}
function subscriberTagsRes(tagIds: number[]) {
  return jsonOk({ tags: tagIds.map((id) => ({ id, name: `tag-${id}` })) });
}
function tagListRes(tags: Array<{ id: number; name: string }>) {
  return jsonOk({ tags });
}

const FULL_TAG_LIST = [
  { id: 1, name: 'Free-Red' },
  { id: 2, name: 'Free-Yellow' },
  { id: 3, name: 'Free-Green' },
];

// Fetch call order for syncSubscriberBucket:
// 1. POST /subscribers  (upsertSubscriber)
// 2. GET  /subscribers/{id}/tags  (getSubscriberTags)
// 3. GET  /tags  (resolveTagId, first tag; populates cache for all)
// 4+. POST or DELETE per tag that needs changing

describe('KitClient.syncSubscriberBucket', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('adds the correct bucket tag when subscriber has none', async () => {
    mockFetch
      .mockResolvedValueOnce(subscriberRes(42))
      .mockResolvedValueOnce(subscriberTagsRes([]))
      .mockResolvedValueOnce(tagListRes(FULL_TAG_LIST))
      .mockResolvedValueOnce(deleteOk());

    const { KitClient } = await import('../../../automations/free-member-sync/kit-client.js');
    const client = new KitClient('test-api-key');
    await client.syncSubscriberBucket('test@example.com', 'Green');

    const [addUrl, addInit] = mockFetch.mock.calls[3] as [string, RequestInit];
    expect(addUrl).toContain('/tags/3/subscribers');
    expect(addInit?.method).toBe('POST');
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('removes all Free-* tags for a purchaser (bucket=null)', async () => {
    mockFetch
      .mockResolvedValueOnce(subscriberRes(42))
      .mockResolvedValueOnce(subscriberTagsRes([2]))
      .mockResolvedValueOnce(tagListRes(FULL_TAG_LIST))
      .mockResolvedValueOnce(deleteOk());

    const { KitClient } = await import('../../../automations/free-member-sync/kit-client.js');
    const client = new KitClient('test-api-key');
    await client.syncSubscriberBucket('buyer@example.com', null);

    const [removeUrl, removeInit] = mockFetch.mock.calls[3] as [string, RequestInit];
    expect(removeUrl).toContain('/tags/2/subscribers/42');
    expect(removeInit?.method).toBe('DELETE');
  });

  it('does nothing when subscriber already has the correct tag and no others', async () => {
    mockFetch
      .mockResolvedValueOnce(subscriberRes(42))
      .mockResolvedValueOnce(subscriberTagsRes([1]))
      .mockResolvedValueOnce(tagListRes(FULL_TAG_LIST));

    const { KitClient } = await import('../../../automations/free-member-sync/kit-client.js');
    const client = new KitClient('test-api-key');
    await client.syncSubscriberBucket('test@example.com', 'Red');

    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('creates tags that do not exist in Kit (list fetched once)', async () => {
    mockFetch
      .mockResolvedValueOnce(subscriberRes(42))
      .mockResolvedValueOnce(subscriberTagsRes([]))
      .mockResolvedValueOnce(tagListRes([]))
      .mockResolvedValueOnce(jsonOk({ tag: { id: 10, name: 'Free-Red' } }))
      .mockResolvedValueOnce(jsonOk({ tag: { id: 11, name: 'Free-Yellow' } }))
      .mockResolvedValueOnce(deleteOk())
      .mockResolvedValueOnce(jsonOk({ tag: { id: 12, name: 'Free-Green' } }));

    const { KitClient } = await import('../../../automations/free-member-sync/kit-client.js');
    const client = new KitClient('test-api-key');
    await client.syncSubscriberBucket('test@example.com', 'Yellow');

    expect(mockFetch).toHaveBeenCalledTimes(7);
    const [addUrl, addInit] = mockFetch.mock.calls[5] as [string, RequestInit];
    expect(addUrl).toContain('/tags/11/subscribers');
    expect(addInit?.method).toBe('POST');
  });
});
