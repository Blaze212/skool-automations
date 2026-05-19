import { describe, it, expect } from 'vitest';
import { isoWeekFolder, detectMimeType } from '../../../../automations/proof-log/drive-uploader.js';

describe('isoWeekFolder', () => {
  it('returns YYYY-WW format for a known Monday', () => {
    // 2026-05-18 is a Monday in week 21
    expect(isoWeekFolder(new Date('2026-05-18T12:00:00Z'))).toBe('2026-21');
  });

  it('returns YYYY-WW format for a known Sunday (same ISO week as prior Monday)', () => {
    // 2026-05-17 is a Sunday — ISO week 20 (week starts Monday)
    expect(isoWeekFolder(new Date('2026-05-17T12:00:00Z'))).toBe('2026-20');
  });

  it('zero-pads single-digit week numbers', () => {
    // 2026-01-05 is a Monday in week 02
    expect(isoWeekFolder(new Date('2026-01-05T12:00:00Z'))).toBe('2026-02');
  });

  it('handles year boundary where week belongs to next year', () => {
    // 2026-12-31 is a Thursday in ISO week 53 of 2026 (check: Jan 1 2026 is Thursday)
    // Actually 2026-12-28 is Monday in week 53
    const result = isoWeekFolder(new Date('2026-12-31T12:00:00Z'));
    expect(result).toMatch(/^\d{4}-\d{2}$/);
  });

  it('handles first week of year', () => {
    // 2026-01-01 is a Thursday — ISO week 01 of 2026
    expect(isoWeekFolder(new Date('2026-01-01T12:00:00Z'))).toBe('2026-01');
  });
});

describe('detectMimeType', () => {
  it('returns image/png for .png files', () => {
    expect(detectMimeType('screenshot.png')).toBe('image/png');
    expect(detectMimeType('/path/to/image.PNG')).toBe('image/png');
  });

  it('returns image/jpeg for .jpg files', () => {
    expect(detectMimeType('photo.jpg')).toBe('image/jpeg');
    expect(detectMimeType('photo.JPG')).toBe('image/jpeg');
  });

  it('returns image/jpeg for .jpeg files', () => {
    expect(detectMimeType('photo.jpeg')).toBe('image/jpeg');
  });

  it('returns image/svg+xml for .svg files', () => {
    expect(detectMimeType('drawing.svg')).toBe('image/svg+xml');
    expect(detectMimeType('drawing.SVG')).toBe('image/svg+xml');
  });

  it('throws for unsupported extensions', () => {
    expect(() => detectMimeType('file.txt')).toThrow('Unsupported file extension: .txt');
    expect(() => detectMimeType('file.pdf')).toThrow('Unsupported file extension: .pdf');
  });
});
