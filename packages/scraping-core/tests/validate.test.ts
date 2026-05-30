import { describe, expect, it } from 'vitest';
import { validate, type ValidationGap } from '../src/validate.js';
import type { PipelineEvent } from '../src/types.js';

function makeEvent(overrides: Partial<PipelineEvent> = {}): PipelineEvent {
  return {
    api_key: '',
    event_type: 'connection_request',
    date: '2026-05-30',
    name: 'Jane Doe',
    title: 'Senior Engineer at Acme',
    linkedin_url: 'https://www.linkedin.com/in/jane-doe',
    page_url: 'https://www.linkedin.com/feed/',
    message_text: '',
    ...overrides,
  };
}

function codes(gaps: ValidationGap[]): string[] {
  return gaps.map((g) => `${g.field}:${g.code}`);
}

describe('validate — happy path', () => {
  it('returns dirty=false and empty gaps when every field is clean', () => {
    const result = validate(makeEvent());
    expect(result.dirty).toBe(false);
    expect(result.gaps).toEqual([]);
  });

  it('accepts a clean direct_message event with empty title', () => {
    // DMs don't require title — chat overlay frequently has no headline.
    const result = validate(makeEvent({ event_type: 'direct_message', title: '' }));
    expect(result.dirty).toBe(false);
    expect(result.gaps).toEqual([]);
  });
});

describe('validate — required-field gaps', () => {
  it('flags missing name', () => {
    const result = validate(makeEvent({ name: '' }));
    expect(result.dirty).toBe(true);
    expect(codes(result.gaps)).toContain('name:missing-required');
  });

  it('flags whitespace-only name as missing', () => {
    const result = validate(makeEvent({ name: '   ' }));
    expect(codes(result.gaps)).toContain('name:missing-required');
  });

  it('flags missing linkedin_url', () => {
    const result = validate(makeEvent({ linkedin_url: '' }));
    expect(codes(result.gaps)).toContain('linkedin_url:missing-required');
  });

  it('flags missing title for connection_request', () => {
    const result = validate(makeEvent({ event_type: 'connection_request', title: '' }));
    expect(codes(result.gaps)).toContain('title:missing-required');
  });

  it('flags missing title for accepted_connection', () => {
    const result = validate(makeEvent({ event_type: 'accepted_connection', title: '' }));
    expect(codes(result.gaps)).toContain('title:missing-required');
  });

  it('does NOT flag missing title for direct_message', () => {
    const result = validate(makeEvent({ event_type: 'direct_message', title: '' }));
    expect(codes(result.gaps)).not.toContain('title:missing-required');
  });

  it('aggregates multiple missing fields in order', () => {
    const result = validate(makeEvent({ name: '', linkedin_url: '', title: '' }));
    expect(codes(result.gaps)).toEqual([
      'name:missing-required',
      'linkedin_url:missing-required',
      'title:missing-required',
    ]);
  });
});

describe('validate — noise patterns', () => {
  it('flags a degree marker leaking into title ("1st")', () => {
    const result = validate(makeEvent({ title: 'Senior Engineer · 1st' }));
    expect(codes(result.gaps)).toContain('title:noise-degree-marker');
  });

  it('flags a degree marker leaking into name ("Jane Doe 2nd")', () => {
    const result = validate(makeEvent({ name: 'Jane Doe 2nd' }));
    expect(codes(result.gaps)).toContain('name:noise-degree-marker');
  });

  it('flags mutual-connection rollup in title', () => {
    const result = validate(makeEvent({ title: '23 mutual connections' }));
    expect(codes(result.gaps)).toContain('title:noise-mutual-connection');
  });

  it('flags Premium badge text in name', () => {
    const result = validate(makeEvent({ name: 'Jane Doe Premium' }));
    expect(codes(result.gaps)).toContain('name:noise-premium-badge');
  });

  it('flags Open-to-work overlay in title', () => {
    const result = validate(makeEvent({ title: 'Open to work · Engineering Manager' }));
    const found = codes(result.gaps);
    expect(found).toContain('title:noise-open-to-work');
    // The "· 1st" pattern requires the marker to be "1st"/"2nd"/"3rd" so the
    // string above only trips open-to-work (and not degree marker).
    expect(found).not.toContain('title:noise-degree-marker');
  });

  it('flags follower-count noise in title', () => {
    const result = validate(makeEvent({ title: '5,234 followers' }));
    expect(codes(result.gaps)).toContain('title:noise-follower-count');
  });

  it('does NOT flag clean titles that merely contain the word "connect"', () => {
    // Defensive: connection-degree pattern should NOT match "connect" or
    // "connections" without the 1st/2nd/3rd marker.
    const result = validate(makeEvent({ title: 'Helping founders connect with capital' }));
    expect(result.dirty).toBe(false);
  });

  it('does NOT flag a legit name like "Premiumshankaracharya"', () => {
    // Word-boundary noise patterns can over-fire. "Premium" as a standalone
    // word should match; embedded in a longer word it should not.
    const result = validate(makeEvent({ name: 'Premiumshankaracharya' }));
    const found = codes(result.gaps);
    expect(found).not.toContain('name:noise-premium-badge');
  });

  it('reports both required and noise gaps when both apply', () => {
    const result = validate(
      makeEvent({
        name: '',
        title: '1st degree connection',
      }),
    );
    const found = codes(result.gaps);
    expect(found).toContain('name:missing-required');
    expect(found).toContain('title:noise-degree-marker');
    // Required-first ordering.
    expect(found.indexOf('name:missing-required')).toBeLessThan(
      found.indexOf('title:noise-degree-marker'),
    );
  });
});

describe('validate — gap message shape', () => {
  it('includes the offending value in noise messages for log debuggability', () => {
    const result = validate(makeEvent({ title: '7 mutual connections' }));
    const gap = result.gaps.find((g) => g.code === 'noise-mutual-connection');
    expect(gap?.message).toContain('7 mutual connections');
  });

  it('uses stable codes (snake-kebab) — no English-only switch keys', () => {
    const result = validate(makeEvent({ name: '', title: '1st place winner' }));
    for (const gap of result.gaps) {
      expect(gap.code).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });
});
