import { describe, expect, it } from 'vitest';
import { scoreCapture } from '../../../pipeline-tracker/src/score-capture.ts';

const VALID_URL = 'https://www.linkedin.com/in/jane-smith';

function cap(name: string, linkedin_url: string = VALID_URL) {
  return { name, linkedin_url };
}

describe('scoreCapture', () => {
  it("returns 'high' when both name and URL are plausible", () => {
    expect(scoreCapture(cap('Jane Smith'))).toBe('high');
    expect(scoreCapture(cap('John'))).toBe('high');
  });

  describe('name junk set', () => {
    for (const junk of ['Connect', 'Follow', 'Message', '1st', '2nd', '3rd', 'You']) {
      it(`rejects junk label "${junk}"`, () => {
        expect(scoreCapture(cap(junk))).toBe('low');
      });
    }

    it('matches junk case-insensitively', () => {
      expect(scoreCapture(cap('connect'))).toBe('low');
      expect(scoreCapture(cap('FOLLOW'))).toBe('low');
    });

    it("allows real names that merely contain a junk word ('Connie')", () => {
      expect(scoreCapture(cap('Connie'))).toBe('high');
    });
  });

  describe('name length edges', () => {
    it('rejects a 1-char name (below min)', () => {
      expect(scoreCapture(cap('A'))).toBe('low');
    });

    it('accepts a 2-char name (at min)', () => {
      expect(scoreCapture(cap('Al'))).toBe('high');
    });

    it('accepts a 60-char name (at max)', () => {
      expect(scoreCapture(cap('a'.repeat(60)))).toBe('high');
    });

    it('rejects a 61-char name (above max)', () => {
      expect(scoreCapture(cap('a'.repeat(61)))).toBe('low');
    });

    it('trims surrounding whitespace before measuring', () => {
      expect(scoreCapture(cap('  Jane Smith  '))).toBe('high');
      expect(scoreCapture(cap('   A   '))).toBe('low');
    });
  });

  describe('name character rules', () => {
    it('accepts hyphens, apostrophes, periods and spaces', () => {
      expect(scoreCapture(cap("Mary-Jane O'Brien Jr."))).toBe('high');
    });

    it('accepts accented and non-Latin names', () => {
      expect(scoreCapture(cap('José Núñez'))).toBe('high');
      expect(scoreCapture(cap('李四'))).toBe('high');
    });

    it('rejects names containing digits', () => {
      expect(scoreCapture(cap('Agent 007'))).toBe('low');
    });

    it('rejects names with stray symbols', () => {
      expect(scoreCapture(cap('Jane (CEO)'))).toBe('low');
      expect(scoreCapture(cap('Jane@Acme'))).toBe('low');
    });

    it('rejects a name that does not start with a letter', () => {
      expect(scoreCapture(cap('-Jane'))).toBe('low');
    });

    it('rejects an empty / missing name', () => {
      expect(scoreCapture(cap(''))).toBe('low');
      expect(scoreCapture({ name: '', linkedin_url: VALID_URL })).toBe('low');
    });
  });

  describe('URL regex', () => {
    it('accepts a canonical /in/ profile URL', () => {
      expect(scoreCapture(cap('Jane Smith', 'https://www.linkedin.com/in/jane-smith-12345'))).toBe(
        'high',
      );
    });

    it('accepts a URL with query/fragment after the slug', () => {
      expect(
        scoreCapture(cap('Jane Smith', 'https://linkedin.com/in/jane-smith?originalSubdomain=uk')),
      ).toBe('high');
    });

    it('rejects a slug shorter than 3 chars', () => {
      expect(scoreCapture(cap('Jane Smith', 'https://www.linkedin.com/in/ab'))).toBe('low');
    });

    it('rejects a non-profile LinkedIn URL', () => {
      expect(scoreCapture(cap('Jane Smith', 'https://www.linkedin.com/feed/'))).toBe('low');
      expect(scoreCapture(cap('Jane Smith', 'https://www.linkedin.com/sales/lead/abc'))).toBe(
        'low',
      );
    });

    it('rejects an empty / missing URL', () => {
      expect(scoreCapture(cap('Jane Smith', ''))).toBe('low');
    });
  });

  it("returns 'low' when only one of the two checks passes", () => {
    // good name, bad URL
    expect(scoreCapture(cap('Jane Smith', 'https://example.com'))).toBe('low');
    // bad name, good URL
    expect(scoreCapture(cap('Connect', VALID_URL))).toBe('low');
  });
});
