/**
 * @vitest-environment jsdom
 */
// Spec 016 — capture card state machine (heuristic + AI).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  renderCaptureSection,
  type AiExtractionResult,
  type CaptureSectionHandle,
} from '../../../pipeline-tracker/src/sidepanel/capture-section.ts';
import type { ManualCaptureInput } from '../../../pipeline-tracker/src/storage.ts';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e?: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
function saveBtnEl(): HTMLButtonElement {
  return root.querySelector('.capture-save-btn') as HTMLButtonElement;
}
function aiBtnEl(): HTMLButtonElement {
  return root.querySelector('.capture-ai-btn') as HTMLButtonElement;
}

// A low-confidence fragment (no https URL) → triggers AI auto-extract.
const HTML_LOW = '<h2>Jane Doe</h2><span>Founder</span>';
const AI_RESULT: AiExtractionResult = {
  fields: {
    name: 'Jane Doe',
    title: 'Founder @ Acme',
    linkedin_url: 'https://acme.com/jane',
    message_text: 'thanks for connecting',
  },
  suggested_event_type: 'direct_message',
};

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

describe('capture card — AI extraction (Phase 2)', () => {
  it('auto-runs AI on a low-confidence drop and locks the card while in flight', async () => {
    const d = deferred<AiExtractionResult | null>();
    const aiExtract = vi.fn(() => d.promise);
    handle = renderCaptureSection(root, { onSave: vi.fn(), aiExtract });

    fireDrop(dropZone(), { html: HTML_LOW });
    await flush();

    expect(aiExtract).toHaveBeenCalledTimes(1);
    expect(handle.getState()).toBe('extracting');
    // Locked: every control disabled, so a late AI write can't clobber an edit.
    expect(inputFor('name').disabled).toBe(true);
    expect(stageSelect().disabled).toBe(true);
    expect(saveBtnEl().disabled).toBe(true);
    expect((root.querySelector('.capture-extracting') as HTMLElement).hidden).toBe(false);

    d.resolve(AI_RESULT);
    await flush();

    expect(handle.getState()).toBe('ready');
    expect(inputFor('name').disabled).toBe(false);
    expect(inputFor('title').value).toBe('Founder @ Acme');
    expect(inputFor('linkedin_url').value).toBe('https://acme.com/jane');
    // Stage dropdown defaults to the AI suggestion.
    expect(stageSelect().value).toBe('direct_message');
  });

  it('unlocks to the heuristic card when extraction throws (E-8)', async () => {
    const aiExtract = vi.fn(async () => {
      throw new Error('model boom');
    });
    handle = renderCaptureSection(root, { onSave: vi.fn(), aiExtract });
    fireDrop(dropZone(), { html: HTML_LOW });
    await flush();
    expect(handle.getState()).toBe('ready');
    expect(inputFor('name').disabled).toBe(false);
    expect(inputFor('name').value).toBe('Jane Doe'); // heuristic stands
  });

  it('falls back to the heuristic (editable, saveable) when AI returns null', async () => {
    const aiExtract = vi.fn(async () => null);
    const onSave = vi.fn(async () => {});
    handle = renderCaptureSection(root, { onSave, aiExtract });
    fireDrop(dropZone(), { html: HTML_LOW });
    await flush();
    expect(handle.getState()).toBe('ready');
    expect(inputFor('name').value).toBe('Jane Doe');
    saveBtnEl().click();
    await flush();
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('does NOT auto-run AI on a high-confidence drop', async () => {
    const aiExtract = vi.fn(async () => AI_RESULT);
    handle = renderCaptureSection(root, { onSave: vi.fn(), aiExtract });
    fireDrop(dropZone(), { html: HTML_JANE }); // has https URL → high confidence
    await flush();
    expect(aiExtract).not.toHaveBeenCalled();
    expect(handle.getState()).toBe('ready');
  });

  it('runs AI on demand via the "Extract with AI" button', async () => {
    const aiExtract = vi.fn(async () => AI_RESULT);
    handle = renderCaptureSection(root, { onSave: vi.fn(), aiExtract });
    fireDrop(dropZone(), { html: HTML_JANE });
    await flush();
    expect(aiBtnEl().hidden).toBe(false);
    aiBtnEl().click();
    await flush();
    expect(aiExtract).toHaveBeenCalledTimes(1);
    expect(inputFor('title').value).toBe('Founder @ Acme');
  });

  it('ignores a new drop while extracting (toast) and keeps the original run', async () => {
    const d = deferred<AiExtractionResult | null>();
    const aiExtract = vi.fn(() => d.promise);
    handle = renderCaptureSection(root, { onSave: vi.fn(), aiExtract });
    fireDrop(dropZone(), { html: HTML_LOW });
    await flush();
    expect(handle.getState()).toBe('extracting');

    fireDrop(dropZone(), { html: '<h2>Bob Smith</h2>' });
    await flush();
    // Still on the first extraction; the second drop did not start a new one.
    expect(aiExtract).toHaveBeenCalledTimes(1);
    expect((root.querySelector('.capture-toast') as HTMLElement).hidden).toBe(false);

    d.resolve(AI_RESULT);
    await flush();
    expect(inputFor('name').value).toBe('Jane Doe');
  });

  it('hides the AI button when no extractor is wired', async () => {
    handle = renderCaptureSection(root, { onSave: vi.fn() });
    fireDrop(dropZone(), { html: HTML_JANE });
    await flush();
    expect(aiBtnEl().hidden).toBe(true);
  });
});

describe('capture card — paste boundary (E-2 negative)', () => {
  it('a paste into a card input does NOT re-capture (paste is scoped to the drop zone)', async () => {
    const aiExtract = vi.fn(async () => AI_RESULT);
    handle = renderCaptureSection(root, { onSave: vi.fn(), aiExtract });
    fireDrop(dropZone(), { html: HTML_JANE });
    await flush();
    expect(inputFor('name').value).toBe('Jane Doe');

    // Paste rich markup into the Message field — must stay a native paste, not
    // trigger a capture (the handler is on the focusable drop zone only).
    firePaste(inputFor('name'), { html: '<h2>Hijacked</h2>' });
    await flush();
    expect(inputFor('name').value).toBe('Jane Doe');
    // Only the initial high-confidence drop happened — no AI re-run from the paste.
    expect(aiExtract).not.toHaveBeenCalled();
  });
});
