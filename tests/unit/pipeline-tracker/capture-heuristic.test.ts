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
  looksLikeConversation,
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

describe('extractHeuristic — V2 reliability (spec 016 prompt-tuning)', () => {
  it('ignores the bold "is a mutual connection" decoy and picks the primary contact', () => {
    // A search-result card: the only <strong> is the mutual-connection decoy.
    const html = `
      <a href="https://www.linkedin.com/in/heather-hund/?lipi=urn%3Ali%3Apage">Heather Hund</a>
      <p><span>Fractional Product Marketing | ex-BCG</span></p>
      <p><span>San Francisco, California</span></p>
      <p><span><a href="https://www.linkedin.com/in/lauradleach/"><strong>Laura Leach</strong></a> is a mutual connection</span></p>`;
    const f = extractHeuristic({ html });
    expect(f.name).toBe('Heather Hund');
    expect(f.title).toBe('Fractional Product Marketing | ex-BCG');
    expect(f.linkedin_url).toBe('https://www.linkedin.com/in/heather-hund/');
  });

  it('skips pronoun + degree chrome lines when choosing the title', () => {
    const html = `<h2>Sean Boyce</h2><p>He/Him</p><p>· 2nd</p><p>Fractional Product and CFO Expert</p>`;
    const f = extractHeuristic({ html });
    expect(f.name).toBe('Sean Boyce');
    expect(f.title).toBe('Fractional Product and CFO Expert');
  });

  it('leaves title empty for a bare name (never invents one) and strips URL tracking', () => {
    const html =
      '<a href="https://www.linkedin.com/in/jane/?lipi=urn%3Ali%3Apage%3Aabc">Jane Doe</a>';
    const f = extractHeuristic({ html });
    expect(f.name).toBe('Jane Doe');
    expect(f.title).toBe('');
    expect(f.linkedin_url).toBe('https://www.linkedin.com/in/jane/');
  });

  it('skips a leading pronoun chip when choosing the name (plain text)', () => {
    const text = 'https://www.linkedin.com/in/jane/?trk=x\nJane Doe\n(She/Her)\nFounder at Acme';
    const f = extractHeuristic({ text });
    expect(f.name).toBe('Jane Doe');
    expect(f.title).toBe('Founder at Acme');
    expect(f.linkedin_url).toBe('https://www.linkedin.com/in/jane/');
  });
});

describe('looksLikeConversation — AI gate for message threads', () => {
  it('detects a thread by its per-bubble attribution line', () => {
    expect(
      looksLikeConversation('<span>Barton Holdridge sent the following message at 4:22 PM</span>'),
    ).toBe(true);
  });

  it('is false for a plain profile / search capture', () => {
    expect(looksLikeConversation('<h2>Jane Doe</h2><p>Founder at Acme</p>')).toBe(false);
    expect(looksLikeConversation('')).toBe(false);
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
