const KIT_API_BASE = 'https://api.kit.com/v4';

export type HealthBucket = 'Red' | 'Yellow' | 'Green';
const ALL_BUCKET_TAGS = ['Free-Red', 'Free-Yellow', 'Free-Green'] as const;
const BUCKET_TAG: Record<HealthBucket, string> = {
  Red: 'Free-Red',
  Yellow: 'Free-Yellow',
  Green: 'Free-Green',
};

interface KitTagResponse {
  tag: { id: number; name: string };
}

interface KitSubscriberResponse {
  subscriber: { id: number; email_address: string };
}

interface KitTagListResponse {
  tags: Array<{ id: number; name: string }>;
}

interface KitSubscriberTagsResponse {
  tags: Array<{ id: number; name: string }>;
}

export class KitClient {
  private apiKey: string;
  private tagIdCache = new Map<string, number>();
  private tagListFetched = false;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async request<T>(method: string, path: string, body?: object): Promise<T> {
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`${KIT_API_BASE}${path}`, init);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Kit API ${method} ${path} → ${res.status}: ${text}`);
    }
    return (await res.json()) as T;
  }

  private async resolveTagId(tagName: string): Promise<number> {
    const cached = this.tagIdCache.get(tagName);
    if (cached !== undefined) return cached;

    if (!this.tagListFetched) {
      this.tagListFetched = true;
      const list = await this.request<KitTagListResponse>('GET', '/tags');
      for (const tag of list.tags) {
        this.tagIdCache.set(tag.name, tag.id);
      }
    }

    if (!this.tagIdCache.has(tagName)) {
      const created = await this.request<KitTagResponse>('POST', '/tags', { name: tagName });
      this.tagIdCache.set(tagName, created.tag.id);
    }

    const id = this.tagIdCache.get(tagName);
    if (id === undefined) throw new Error(`Could not resolve tag id for "${tagName}"`);
    return id;
  }

  private async upsertSubscriber(email: string): Promise<number> {
    const res = await this.request<KitSubscriberResponse>('POST', '/subscribers', {
      email_address: email,
    });
    return res.subscriber.id;
  }

  private async getSubscriberTags(subscriberId: number): Promise<number[]> {
    const res = await this.request<KitSubscriberTagsResponse>(
      'GET',
      `/subscribers/${subscriberId}/tags`,
    );
    return res.tags.map((t) => t.id);
  }

  private async addTag(tagId: number, subscriberId: number): Promise<void> {
    await this.request('POST', `/tags/${tagId}/subscribers`, { subscriber_id: subscriberId });
  }

  private async removeTag(tagId: number, subscriberId: number): Promise<void> {
    await this.request('DELETE', `/tags/${tagId}/subscribers/${subscriberId}`);
  }

  async syncSubscriberBucket(email: string, bucket: HealthBucket | null): Promise<void> {
    const subscriberId = await this.upsertSubscriber(email);
    const currentTagIds = await this.getSubscriberTags(subscriberId);

    for (const tagName of ALL_BUCKET_TAGS) {
      const tagId = await this.resolveTagId(tagName);
      const targetTag = bucket !== null ? BUCKET_TAG[bucket] : null;
      const shouldHaveTag = tagName === targetTag;
      const hasTag = currentTagIds.includes(tagId);

      if (shouldHaveTag && !hasTag) {
        await this.addTag(tagId, subscriberId);
      } else if (!shouldHaveTag && hasTag) {
        await this.removeTag(tagId, subscriberId);
      }
    }
  }
}
