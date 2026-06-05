/**
 * @vitest-environment jsdom
 */
// Spec 016 D-016-2 — site-agnostic heuristic fast-path.

import { describe, expect, it } from 'vitest';
import {
  FRAGMENT_MAX_BYTES,
  capFragment,
  extractHeuristic,
  heuristicConfidence,
} from '../../../pipeline-tracker/src/capture-heuristic.ts';

describe('extractHeuristic — text/html fragment', () => {
  it('pulls name (heading), title (next line), and first https URL', () => {
    const html = `
      <div>
        <a href="https://example.com/u/jane">avatar</a>
        <h2>Jane Doe</h2>
        <span>Head of Growth at Acme</span>
        <a href="https://example.com/u/jane">profile</a>
      </div>`;
    const fields = extractHeuristic({ html });
    expect(fields.name).toBe('Jane Doe');
    expect(fields.title).toBe('Head of Growth at Acme');
    expect(fields.linkedin_url).toBe('https://example.com/u/jane');
    expect(fields.message_text).toBe('');
  });

  it('works on a non-LinkedIn site (no LinkedIn anchoring)', () => {
    const html =
      '<strong>Carlos Núñez</strong><p>VP Engineering · GitHub</p>' +
      '<a href="https://github.com/carlos">github.com/carlos</a>';
    const fields = extractHeuristic({ html });
    expect(fields.name).toBe('Carlos Núñez');
    expect(fields.title).toBe('VP Engineering · GitHub');
    expect(fields.linkedin_url).toBe('https://github.com/carlos');
  });

  it('falls back to the first text line when there is no heading', () => {
    const html = '<div><span>Plain Name</span><span>Some Title</span></div>';
    const fields = extractHeuristic({ html });
    expect(fields.name).toBe('Plain Name');
    expect(fields.title).toBe('Some Title');
  });

  it('skips a bare-URL line when choosing the title', () => {
    const html = '<h3>Jane Doe</h3><div>https://example.com/jane</div><div>Founder</div>';
    const fields = extractHeuristic({ html });
    expect(fields.title).toBe('Founder');
  });
});

describe('extractHeuristic — text/plain fragment', () => {
  it('parses line structure from plain text', () => {
    const text = 'Jane Doe\nHead of Growth at Acme\nhttps://example.com/jane';
    const fields = extractHeuristic({ text });
    expect(fields.name).toBe('Jane Doe');
    expect(fields.title).toBe('Head of Growth at Acme');
    expect(fields.linkedin_url).toBe('https://example.com/jane');
  });

  it('prefers html when both are present', () => {
    const fields = extractHeuristic({
      html: '<h2>From HTML</h2>',
      text: 'From Text',
    });
    expect(fields.name).toBe('From HTML');
  });
});

describe('extractHeuristic — empty inputs', () => {
  it('returns blank fields for an empty fragment', () => {
    expect(extractHeuristic({})).toEqual({
      name: '',
      title: '',
      linkedin_url: '',
      message_text: '',
    });
  });

  it('returns blank fields for whitespace-only html', () => {
    expect(extractHeuristic({ html: '   ' }).name).toBe('');
  });
});

describe('heuristicConfidence — site-agnostic', () => {
  it("returns 'high' for a plausible name + non-empty https URL on any host", () => {
    expect(heuristicConfidence({ name: 'Jane Doe', linkedin_url: 'https://github.com/jane' })).toBe(
      'high',
    );
    expect(
      heuristicConfidence({ name: 'Jane Doe', linkedin_url: 'https://www.linkedin.com/in/jane' }),
    ).toBe('high');
  });

  it("returns 'low' when the URL is missing", () => {
    expect(heuristicConfidence({ name: 'Jane Doe', linkedin_url: '' })).toBe('low');
  });

  it("returns 'low' when the URL is not https", () => {
    expect(heuristicConfidence({ name: 'Jane Doe', linkedin_url: 'http://example.com' })).toBe(
      'low',
    );
  });

  it("returns 'low' when the name is junk / implausible", () => {
    expect(heuristicConfidence({ name: 'Connect', linkedin_url: 'https://x.com/a' })).toBe('low');
    expect(heuristicConfidence({ name: 'Agent 007', linkedin_url: 'https://x.com/a' })).toBe('low');
    expect(heuristicConfidence({ name: '', linkedin_url: 'https://x.com/a' })).toBe('low');
  });
});

describe('capFragment — 64 KB pre-parse cap (E-10)', () => {
  it('returns short fragments unchanged', () => {
    expect(capFragment('<div>hi</div>')).toBe('<div>hi</div>');
  });

  it('caps an oversized fragment to ≤ FRAGMENT_MAX_BYTES bytes', () => {
    const huge = '<p>' + 'x'.repeat(FRAGMENT_MAX_BYTES * 2) + '</p>';
    const capped = capFragment(huge);
    expect(new TextEncoder().encode(capped).length).toBeLessThanOrEqual(FRAGMENT_MAX_BYTES);
    expect(capped.length).toBeLessThan(huge.length);
  });

  it('drops a dangling open tag left by the byte-cut', () => {
    // A run of complete tags followed by an unterminated one near the cap.
    const body = '<span>a</span>'.repeat(Math.ceil(FRAGMENT_MAX_BYTES / 14));
    const capped = capFragment(body + '<spanthatneverc');
    expect(capped.endsWith('<spanthatneverc')).toBe(false);
  });
});
