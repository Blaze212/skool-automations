// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { RECOVERED_HTML_CAP_BYTES, stripHtmlForCarry } from '../../src/ai-fallback/strip-html.js';

describe('stripHtmlForCarry', () => {
  it('returns empty string for empty input', () => {
    expect(stripHtmlForCarry('')).toBe('');
  });

  it.each(['script', 'svg', 'img', 'style', 'link', 'iframe'])('removes <%s> elements', (tag) => {
    const html = `<div><span>keep</span><${tag}></${tag}></div>`;
    const out = stripHtmlForCarry(html);
    expect(out).toContain('keep');
    expect(out.toLowerCase()).not.toContain(`<${tag}`);
  });

  it('keeps surrounding text when removing a banned tag', () => {
    const out = stripHtmlForCarry('<p>Jane Doe<img src="x.png">Head of Growth</p>');
    expect(out).toContain('Jane Doe');
    expect(out).toContain('Head of Growth');
    expect(out).not.toContain('<img');
  });

  it('collapses whitespace runs in text nodes', () => {
    const out = stripHtmlForCarry('<p>Jane    \n\t  Doe</p>');
    expect(out).toContain('Jane Doe');
    expect(out).not.toMatch(/Jane\s{2,}Doe/);
  });

  it('returns "" when the stripped result exceeds the byte cap', () => {
    const big = '<p>' + 'a'.repeat(RECOVERED_HTML_CAP_BYTES + 100) + '</p>';
    expect(stripHtmlForCarry(big)).toBe('');
  });

  it('returns the serialized subtree when under the cap', () => {
    const out = stripHtmlForCarry('<div class="card"><b>Hi</b></div>');
    expect(out).toContain('<b>Hi</b>');
  });
});
