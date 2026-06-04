// Spec 015 B2 — side-panel review section.
//
// Coverage:
//   1. Empty queue renders nothing (section hidden).
//   2. One card per entry, inputs pre-filled from the event.
//   3. Save collects the (trimmed) edited values → onSave(historyId, edits).
//   4. "Sync this one" → onSyncOne(historyId).
//   5. "Sync all incl. ⚠" → onSyncAll(all history ids).
//   6. Hostile scraped values are rendered as text/value, never markup.

/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  renderReviewSection,
  type ReviewEntryEdits,
} from '../../../pipeline-tracker/src/sidepanel/review-section.ts';
import type { OutboxEntry } from '../../../pipeline-tracker/src/types.ts';

function makeEntry(id: string, overrides: Partial<OutboxEntry['event']> = {}): OutboxEntry {
  return {
    history_id: id,
    enqueued_at: '2026-06-01T00:00:00Z',
    attempts: 0,
    scrape_confidence: 'low',
    needs_review: true,
    event: {
      api_key: 'pk',
      event_type: 'connection_request',
      date: '2026-06-01',
      name: 'Connect',
      title: 'Some Title',
      linkedin_url: 'https://www.linkedin.com/feed/',
      page_url: 'https://www.linkedin.com/feed/',
      message_text: '',
      scrape_confidence: 'low',
      ...overrides,
    },
  };
}

let root: HTMLElement;
const noop = () => {};

function handlers(over: Partial<Parameters<typeof renderReviewSection>[1]> = {}) {
  return {
    entries: [],
    onSave: noop,
    onSyncOne: noop,
    onSyncAll: noop,
    ...over,
  };
}

beforeEach(() => {
  root = document.createElement('div');
  document.body.appendChild(root);
});

afterEach(() => {
  root.remove();
  vi.restoreAllMocks();
});

describe('renderReviewSection', () => {
  it('renders nothing when the queue is empty', () => {
    renderReviewSection(root, handlers({ entries: [] }));
    expect(root.children).toHaveLength(0);
  });

  it('renders one card per entry with inputs pre-filled from the event', () => {
    renderReviewSection(
      root,
      handlers({ entries: [makeEntry('a', { name: 'Jane', title: 'CEO' })] }),
    );

    expect(root.querySelectorAll('.review-card')).toHaveLength(1);
    expect(root.querySelector('.review-count')?.textContent).toBe('1');

    const inputs = Array.from(root.querySelectorAll('input.review-input')) as HTMLInputElement[];
    const byField = Object.fromEntries(inputs.map((i) => [i.dataset.field, i.value]));
    expect(byField.name).toBe('Jane');
    expect(byField.title).toBe('CEO');
    expect(byField.linkedin_url).toBe('https://www.linkedin.com/feed/');
  });

  it('Save sends the trimmed edited values to onSave', () => {
    const onSave = vi.fn();
    renderReviewSection(root, handlers({ entries: [makeEntry('h-1')], onSave }));

    const inputs = Array.from(root.querySelectorAll('input.review-input')) as HTMLInputElement[];
    const get = (f: string) => inputs.find((i) => i.dataset.field === f)!;
    get('name').value = '  Jane Smith  ';
    get('title').value = 'Staff Engineer';
    get('linkedin_url').value = 'https://www.linkedin.com/in/jane-smith';
    const message = root.querySelector(
      'textarea[data-field="message_text"]',
    ) as HTMLTextAreaElement;
    message.value = '  Hi Jane — great to connect!  ';

    (root.querySelector('.review-save-btn') as HTMLButtonElement).click();

    expect(onSave).toHaveBeenCalledTimes(1);
    const [id, edits] = onSave.mock.calls[0] as [string, ReviewEntryEdits];
    expect(id).toBe('h-1');
    expect(edits).toEqual({
      name: 'Jane Smith',
      title: 'Staff Engineer',
      linkedin_url: 'https://www.linkedin.com/in/jane-smith',
      message_text: 'Hi Jane — great to connect!',
    });
  });

  it('pre-fills the message textarea from the captured event', () => {
    renderReviewSection(
      root,
      handlers({ entries: [makeEntry('m-1', { message_text: 'Original note' })] }),
    );

    const message = root.querySelector(
      'textarea[data-field="message_text"]',
    ) as HTMLTextAreaElement;
    expect(message.value).toBe('Original note');
  });

  it('"Sync this one" approves a single entry as-is', () => {
    const onSyncOne = vi.fn();
    renderReviewSection(root, handlers({ entries: [makeEntry('h-9')], onSyncOne }));

    (root.querySelector('.review-sync-one-btn') as HTMLButtonElement).click();

    expect(onSyncOne).toHaveBeenCalledExactlyOnceWith('h-9');
  });

  it('"Sync all incl. ⚠" approves every queued entry', () => {
    const onSyncAll = vi.fn();
    renderReviewSection(
      root,
      handlers({ entries: [makeEntry('a'), makeEntry('b'), makeEntry('c')], onSyncAll }),
    );

    (root.querySelector('.review-sync-all-btn') as HTMLButtonElement).click();

    expect(onSyncAll).toHaveBeenCalledExactlyOnceWith(['a', 'b', 'c']);
  });

  it('renders hostile values as input text, not markup', () => {
    const evil = '<img src=x onerror=alert(1)>';
    renderReviewSection(root, handlers({ entries: [makeEntry('x', { name: evil })] }));

    // No injected element; the value round-trips verbatim through the input.
    expect(root.querySelector('img')).toBeNull();
    const nameInput = root.querySelector('input[data-field="name"]') as HTMLInputElement;
    expect(nameInput.value).toBe(evil);
  });

  it('re-rendering into the same root replaces the prior subtree (no leak)', () => {
    renderReviewSection(root, handlers({ entries: [makeEntry('a'), makeEntry('b')] }));
    expect(root.querySelectorAll('.review-card')).toHaveLength(2);

    renderReviewSection(root, handlers({ entries: [makeEntry('a')] }));
    expect(root.querySelectorAll('.review-card')).toHaveLength(1);

    renderReviewSection(root, handlers({ entries: [] }));
    expect(root.children).toHaveLength(0);
  });
});
