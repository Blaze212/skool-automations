/**
 * @vitest-environment jsdom
 */
// Spec 016 — capture card state machine (Phase 1: heuristic, no AI).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  renderCaptureSection,
  type CaptureSectionHandle,
} from '../../../pipeline-tracker/src/sidepanel/capture-section.ts';
import type { ManualCaptureInput } from '../../../pipeline-tracker/src/storage.ts';

let root: HTMLElement;
let handle: CaptureSectionHandle | null = null;

beforeEach(() => {
  document.body.innerHTML = '<div id="capture"></div>';
  root = document.getElementById('capture') as HTMLElement;
});

afterEach(() => {
  handle?.destroy();
  handle = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/** Minimal DataTransfer stand-in carrying html/plain payloads. */
function dataTransfer(payload: { html?: string; text?: string }): DataTransfer {
  return {
    getData: (type: string) =>
      type === 'text/html'
        ? (payload.html ?? '')
        : type === 'text/plain'
          ? (payload.text ?? '')
          : '',
    dropEffect: 'none',
  } as unknown as DataTransfer;
}

/** Flush pending microtasks + a macrotask (covers async getPageUrl / save). */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function fireDrop(el: HTMLElement, payload: { html?: string; text?: string }): void {
  const e = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(e, 'dataTransfer', { value: dataTransfer(payload) });
  el.dispatchEvent(e);
}

function firePaste(el: HTMLElement, payload: { html?: string; text?: string }): void {
  const e = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(e, 'clipboardData', { value: dataTransfer(payload) });
  el.dispatchEvent(e);
}

const HTML_JANE =
  '<h2>Jane Doe</h2><span>Head of Growth</span><a href="https://github.com/jane">x</a>';

function dropZone(): HTMLElement {
  return root.querySelector('.capture-dropzone') as HTMLElement;
}
function card(): HTMLElement {
  return root.querySelector('.capture-card') as HTMLElement;
}
function inputFor(field: string): HTMLInputElement {
  return root.querySelector(`[data-field="${field}"]`) as HTMLInputElement;
}
function stageSelect(): HTMLSelectElement {
  return root.querySelector('.capture-stage-select') as HTMLSelectElement;
}

describe('capture card — drop / paste → heuristic prefill', () => {
  it('starts Empty with the card hidden', () => {
    handle = renderCaptureSection(root, { onSave: vi.fn() });
    expect(handle.getState()).toBe('empty');
    expect(card().hidden).toBe(true);
  });

  it('prefills the card from a dropped html fragment', async () => {
    handle = renderCaptureSection(root, { onSave: vi.fn() });
    fireDrop(dropZone(), { html: HTML_JANE });
    await flush();
    expect(handle.getState()).toBe('ready');
    expect(card().hidden).toBe(false);
    expect(inputFor('name').value).toBe('Jane Doe');
    expect(inputFor('title').value).toBe('Head of Growth');
    expect(inputFor('linkedin_url').value).toBe('https://github.com/jane');
  });

  it('a paste produces an identical prefilled card', async () => {
    handle = renderCaptureSection(root, { onSave: vi.fn() });
    firePaste(dropZone(), { html: HTML_JANE });
    await flush();
    expect(inputFor('name').value).toBe('Jane Doe');
    expect(inputFor('linkedin_url').value).toBe('https://github.com/jane');
  });

  it('shows a toast and stays Empty for a no-content selection', async () => {
    handle = renderCaptureSection(root, { onSave: vi.fn() });
    fireDrop(dropZone(), { html: '<div></div>' });
    await flush();
    expect(handle.getState()).toBe('empty');
    expect((root.querySelector('.capture-toast') as HTMLElement).hidden).toBe(false);
  });
});

describe('capture card — Stage dropdown', () => {
  it('defaults to connection_request when there is no AI suggestion', async () => {
    handle = renderCaptureSection(root, { onSave: vi.fn() });
    fireDrop(dropZone(), { html: HTML_JANE });
    await flush();
    expect(stageSelect().value).toBe('connection_request');
  });

  it('maps the chosen label to the wire event_type on save', async () => {
    const onSave = vi.fn(async () => {});
    handle = renderCaptureSection(root, { onSave, getPageUrl: async () => 'https://example.com' });
    fireDrop(dropZone(), { html: HTML_JANE });
    await flush();

    stageSelect().value = 'direct_message';
    (root.querySelector('.capture-save-btn') as HTMLButtonElement).click();
    await flush();
    await flush();

    const capture = onSave.mock.calls[0][0] as ManualCaptureInput;
    expect(capture.event_type).toBe('direct_message');
    expect(capture.name).toBe('Jane Doe');
    expect(capture.page_url).toBe('https://example.com');
  });
});

describe('capture card — save', () => {
  it('resets to Empty after a successful save', async () => {
    const onSave = vi.fn(async () => {});
    handle = renderCaptureSection(root, { onSave });
    fireDrop(dropZone(), { html: HTML_JANE });
    await flush();
    (root.querySelector('.capture-save-btn') as HTMLButtonElement).click();
    await flush();
    await flush();
    expect(handle.getState()).toBe('empty');
    expect(card().hidden).toBe(true);
  });

  it('keeps the card populated + shows an inline error when save fails', async () => {
    const onSave = vi.fn(async () => {
      throw new Error('Outbox is full (50 unsynced events)');
    });
    handle = renderCaptureSection(root, { onSave });
    fireDrop(dropZone(), { html: HTML_JANE });
    await flush();
    (root.querySelector('.capture-save-btn') as HTMLButtonElement).click();
    await flush();
    await flush();

    expect(handle.getState()).toBe('ready');
    expect(card().hidden).toBe(false);
    expect(inputFor('name').value).toBe('Jane Doe');
    const err = root.querySelector('.capture-error') as HTMLElement;
    expect(err.hidden).toBe(false);
    expect(err.textContent).toMatch(/sync or clear/i);
  });
});

describe('capture card — replace confirm (E-3)', () => {
  it('replaces the card when confirmReplace returns true', async () => {
    const confirmReplace = vi.fn(() => true);
    handle = renderCaptureSection(root, { onSave: vi.fn(), confirmReplace });
    fireDrop(dropZone(), { html: HTML_JANE });
    await flush();
    fireDrop(dropZone(), { html: '<h2>Bob Smith</h2><a href="https://x.com/bob">x</a>' });
    await flush();
    expect(confirmReplace).toHaveBeenCalled();
    expect(inputFor('name').value).toBe('Bob Smith');
  });

  it('keeps the existing card when confirmReplace returns false', async () => {
    const confirmReplace = vi.fn(() => false);
    handle = renderCaptureSection(root, { onSave: vi.fn(), confirmReplace });
    fireDrop(dropZone(), { html: HTML_JANE });
    await flush();
    fireDrop(dropZone(), { html: '<h2>Bob Smith</h2><a href="https://x.com/bob">x</a>' });
    await flush();
    expect(inputFor('name').value).toBe('Jane Doe');
  });

  it('does not confirm on the first drop (Empty → Ready)', async () => {
    const confirmReplace = vi.fn(() => true);
    handle = renderCaptureSection(root, { onSave: vi.fn(), confirmReplace });
    fireDrop(dropZone(), { html: HTML_JANE });
    await flush();
    expect(confirmReplace).not.toHaveBeenCalled();
  });
});
