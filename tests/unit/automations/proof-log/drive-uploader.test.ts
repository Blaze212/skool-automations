import { describe, it, expect } from 'vitest';
import { applyPostfix, detectMimeType } from '../../../../automations/proof-log/drive-uploader.js';

describe('applyPostfix', () => {
  it('returns original filename unchanged for original subfolder', () => {
    expect(applyPostfix('boeing-win.png', 'original')).toBe('boeing-win.png');
  });

  it('appends -redacted before extension for redacted subfolder', () => {
    expect(applyPostfix('boeing-win.svg', 'redacted')).toBe('boeing-win-redacted.svg');
  });

  it('appends -final before extension for final subfolder', () => {
    expect(applyPostfix('boeing-win.png', 'final')).toBe('boeing-win-final.png');
  });

  it('handles full paths — only basename is used', () => {
    expect(applyPostfix('/inbox/2026-05/boeing-win.png', 'final')).toBe('boeing-win-final.png');
  });

  it('preserves extension case', () => {
    expect(applyPostfix('screenshot.PNG', 'redacted')).toBe('screenshot-redacted.PNG');
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
