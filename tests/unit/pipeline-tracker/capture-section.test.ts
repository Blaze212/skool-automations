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
    profile_url: 'https://acme.com/jane',
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
    expect(inputFor('profile_url').value).toBe('https://github.com/jane');
  });

  it('a paste produces an identical prefilled card', async () => {
    handle = renderCaptureSection(root, { onSave: vi.fn() });
    firePaste(dropZone(), { html: HTML_JANE });
    await flush();
    expect(inputFor('name').value).toBe('Jane Doe');
    expect(inputFor('profile_url').value).toBe('https://github.com/jane');
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

  it('paints a color-bubble class matching the selected stage (badge colors)', async () => {
    handle = renderCaptureSection(root, { onSave: vi.fn() });
    fireDrop(dropZone(), { html: HTML_JANE });
    await flush();
    // Default stage → its color class is applied.
    expect(stageSelect().classList.contains('stage-connection_request')).toBe(true);
    // Changing the stage swaps the class (and drops the old one).
    stageSelect().value = 'direct_message';
    stageSelect().dispatchEvent(new Event('change'));
    expect(stageSelect().classList.contains('stage-direct_message')).toBe(true);
    expect(stageSelect().classList.contains('stage-connection_request')).toBe(false);
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

describe('capture card — new drop overwrites the pending one (temporary)', () => {
  // Sample-collection mode: a new drop always replaces whatever is pending, with
  // NO confirm prompt (confirmReplace is intentionally never consulted).
  it('a second drop overwrites a Ready card without consulting confirmReplace', async () => {
    const confirmReplace = vi.fn(() => false);
    handle = renderCaptureSection(root, { onSave: vi.fn(), confirmReplace });
    fireDrop(dropZone(), { html: HTML_JANE });
    await flush();
    fireDrop(dropZone(), { html: '<h2>Bob Smith</h2><a href="https://x.com/bob">x</a>' });
    await flush();
    expect(confirmReplace).not.toHaveBeenCalled();
    expect(inputFor('name').value).toBe('Bob Smith');
  });

  it('does not consult confirmReplace on the first drop', async () => {
    const confirmReplace = vi.fn(() => true);
    handle = renderCaptureSection(root, { onSave: vi.fn(), confirmReplace });
    fireDrop(dropZone(), { html: HTML_JANE });
    await flush();
    expect(confirmReplace).not.toHaveBeenCalled();
    expect(inputFor('name').value).toBe('Jane Doe');
  });
});

describe('capture card — AI extraction (Phase 2)', () => {
  it('locks the card while AI extraction (run via the button) is in flight', async () => {
    const d = deferred<AiExtractionResult | null>();
    const aiExtract = vi.fn(() => d.promise);
    handle = renderCaptureSection(root, { onSave: vi.fn(), aiExtract });

    fireDrop(dropZone(), { html: HTML_LOW });
    await flush();
    // No auto-run on drop — the card just shows the heuristic result.
    expect(aiExtract).not.toHaveBeenCalled();
    expect(handle.getState()).toBe('ready');

    aiBtnEl().click();
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
    expect(inputFor('profile_url').value).toBe('https://acme.com/jane');
    // The model owns name/title/url; with no thread text the regex finds no owner
    // message, so message_text falls back to the model's value...
    expect(inputFor('message_text').value).toBe('thanks for connecting');
    // ...and the stage is DETERMINISTIC (the model's guess is ignored): a plain
    // profile drop with no conversation → connection_request.
    expect(stageSelect().value).toBe('connection_request');
  });

  it('a thread drop sets message_text + DM stage deterministically (regex wins)', async () => {
    // The model returns a WRONG message + stage; the deterministic pass overrides.
    const aiExtract = vi.fn(
      async (): Promise<AiExtractionResult> => ({
        fields: {
          name: 'Katie McIntyre',
          title: '',
          profile_url: 'https://linkedin.com/in/katie',
          message_text: 'the model picked the wrong message',
        },
        suggested_event_type: 'connection_request',
      }),
    );
    const text = [
      'Katie McIntyre   10:54 PM',
      'Back at ya',
      '',
      'Monday',
      "View Barton's profileBarton Holdridge",
      'Barton Holdridge   6:15 PM',
      'Hey Katie, worth a quick Zoom?',
    ].join('\n');
    handle = renderCaptureSection(root, {
      onSave: vi.fn(),
      aiExtract,
      getOwnerName: () => 'Barton Holdridge',
    });

    // A conversation fragment carries both html (for name/url) and text (for the
    // deterministic message/stage pass).
    fireDrop(dropZone(), { html: '<h2>Katie McIntyre</h2>', text });
    await flush();

    // Deterministic message + stage apply immediately on drop, with no AI run.
    expect(aiExtract).not.toHaveBeenCalled();
    expect(handle.getState()).toBe('ready');
    expect(inputFor('message_text').value).toBe('Hey Katie, worth a quick Zoom?');
    expect(stageSelect().value).toBe('direct_message');

    // Even when the user runs AI, the regex message + stage still win.
    aiBtnEl().click();
    await flush();
    expect(inputFor('message_text').value).toBe('Hey Katie, worth a quick Zoom?');
    expect(stageSelect().value).toBe('direct_message');
  });

  it('unlocks to the heuristic card when extraction throws (E-8)', async () => {
    const aiExtract = vi.fn(async () => {
      throw new Error('model boom');
    });
    handle = renderCaptureSection(root, { onSave: vi.fn(), aiExtract });
    fireDrop(dropZone(), { html: HTML_LOW });
    await flush();
    aiBtnEl().click();
    await flush();
    expect(handle.getState()).toBe('ready');
    expect(inputFor('name').disabled).toBe(false);
    expect(inputFor('name').value).toBe('Jane Doe'); // heuristic stands
  });

  it('shows a warning banner (not silent) when the AI times out, card stays usable', async () => {
    const aiExtract = vi.fn(async () => ({ timedOut: true }) as const);
    const onSave = vi.fn(async () => {});
    handle = renderCaptureSection(root, { onSave, aiExtract });
    fireDrop(dropZone(), { html: HTML_LOW });
    await flush();
    aiBtnEl().click();
    await flush();

    expect(handle.getState()).toBe('ready');
    const warning = root.querySelector('.capture-warning') as HTMLElement;
    expect(warning.hidden).toBe(false);
    expect(warning.textContent).toMatch(/timed out/i);
    // Heuristic values stand and the card is editable + saveable.
    expect(inputFor('name').value).toBe('Jane Doe');
    expect(inputFor('name').disabled).toBe(false);
    saveBtnEl().click();
    await flush();
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('shows a warning banner when the input is too large for the AI', async () => {
    const aiExtract = vi.fn(async () => ({ tooLarge: true }) as const);
    const onSave = vi.fn(async () => {});
    handle = renderCaptureSection(root, { onSave, aiExtract });
    fireDrop(dropZone(), { html: HTML_LOW });
    await flush();
    aiBtnEl().click();
    await flush();

    expect(handle.getState()).toBe('ready');
    const warning = root.querySelector('.capture-warning') as HTMLElement;
    expect(warning.hidden).toBe(false);
    expect(warning.textContent).toMatch(/too large/i);
    // Heuristic values stand and the card is still saveable.
    expect(inputFor('name').value).toBe('Jane Doe');
    saveBtnEl().click();
    await flush();
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('clears the timeout warning on the next drop', async () => {
    const aiExtract = vi
      .fn<() => Promise<AiExtractionResult | { timedOut: true } | null>>()
      .mockResolvedValue({ timedOut: true });
    handle = renderCaptureSection(root, { onSave: vi.fn(), aiExtract });

    fireDrop(dropZone(), { html: HTML_LOW });
    await flush();
    aiBtnEl().click(); // run AI on demand → times out → warning shown
    await flush();
    expect((root.querySelector('.capture-warning') as HTMLElement).hidden).toBe(false);

    // A fresh drop clears the warning (and does not re-run AI).
    fireDrop(dropZone(), { html: HTML_LOW });
    await flush();
    expect((root.querySelector('.capture-warning') as HTMLElement).hidden).toBe(true);
  });

  it('falls back to the heuristic (editable, saveable) when AI returns null', async () => {
    const aiExtract = vi.fn(async () => null);
    const onSave = vi.fn(async () => {});
    handle = renderCaptureSection(root, { onSave, aiExtract });
    fireDrop(dropZone(), { html: HTML_LOW });
    await flush();
    aiBtnEl().click();
    await flush();
    expect(handle.getState()).toBe('ready');
    expect(inputFor('name').value).toBe('Jane Doe');
    saveBtnEl().click();
    await flush();
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('never auto-runs AI on a drop — even a low-confidence one (regex is trusted)', async () => {
    const aiExtract = vi.fn(async () => AI_RESULT);
    handle = renderCaptureSection(root, { onSave: vi.fn(), aiExtract });
    fireDrop(dropZone(), { html: HTML_LOW }); // no https URL → would have been low-confidence
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

  it('a new drop while AI is extracting is ignored with a toast (card stays locked)', async () => {
    // The card is locked during extraction, so a mid-extraction drop must NOT
    // race the in-flight run — it is ignored with a toast and the original
    // extraction resolves normally onto the original card.
    const first = deferred<AiExtractionResult | null>();
    const aiExtract = vi.fn<(input: unknown) => Promise<AiExtractionResult | null>>(
      () => first.promise,
    );
    handle = renderCaptureSection(root, { onSave: vi.fn(), aiExtract });

    fireDrop(dropZone(), { html: HTML_LOW }); // Jane heuristic, no auto-run
    await flush();
    aiBtnEl().click(); // extraction in flight
    await flush();
    expect(handle.getState()).toBe('extracting');

    fireDrop(dropZone(), { html: '<h2>Bob Smith</h2>' }); // ignored — still extracting
    await flush();
    expect(handle.getState()).toBe('extracting');
    expect((root.querySelector('.capture-toast') as HTMLElement).hidden).toBe(false);
    expect(aiExtract).toHaveBeenCalledTimes(1); // the second drop did NOT start a run

    // The original extraction resolves → applies to the original (Jane) card.
    first.resolve(AI_RESULT);
    await flush();
    expect(handle.getState()).toBe('ready');
    expect(inputFor('name').value).toBe(AI_RESULT.fields.name);
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
