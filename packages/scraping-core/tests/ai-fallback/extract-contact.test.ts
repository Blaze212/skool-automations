import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractContact } from '../../src/ai-fallback/extract-contact.js';
import type { ContactFields, ExtractContactInput } from '../../src/ai-fallback/types.js';
import {
  installLanguageModel,
  uninstallLanguageModel,
} from '../../../../tests/__mocks__/language-model.ts';

function candidate(overrides: Partial<ContactFields> = {}): ContactFields {
  return {
    name: '',
    title: 'Premium',
    profile_url: '',
    message_text: '',
    ...overrides,
  };
}

function input(overrides: Partial<ExtractContactInput> = {}): ExtractContactInput {
  return {
    trimmedHtml: '<div>Jane Doe — Head of Growth at Acme</div>',
    candidate: candidate(),
    pageUrl: 'https://example.com/jane',
    ...overrides,
  };
}

function result(fields: Record<string, unknown>): string {
  return JSON.stringify({
    name: null,
    title: null,
    profile_url: null,
    message_text: null,
    suggested_event_type: null,
    ...fields,
  });
}

afterEach(() => {
  uninstallLanguageModel();
  vi.useRealTimers();
});

describe('extractContact() — never throws, returns null on every failure mode', () => {
  it('returns null when LanguageModel is absent', async () => {
    uninstallLanguageModel();
    await expect(extractContact(input())).resolves.toBeNull();
  });

  it('returns null when availability() throws', async () => {
    installLanguageModel({ availabilityThrows: true });
    await expect(extractContact(input())).resolves.toBeNull();
  });

  it.each(['unavailable', 'downloadable', 'downloading'] as const)(
    'returns null when availability is "%s"',
    async (state) => {
      installLanguageModel({ availability: state });
      await expect(extractContact(input())).resolves.toBeNull();
    },
  );

  it('returns null when create() throws', async () => {
    installLanguageModel({ createThrows: true });
    await expect(extractContact(input())).resolves.toBeNull();
  });

  it('returns null when prompt() rejects', async () => {
    installLanguageModel({ promptThrows: true });
    await expect(extractContact(input())).resolves.toBeNull();
  });

  it('returns null when prompt() returns invalid JSON', async () => {
    installLanguageModel({ promptResult: 'not json{' });
    await expect(extractContact(input())).resolves.toBeNull();
  });

  it('returns null when JSON is missing a required field', async () => {
    installLanguageModel({
      promptResult: JSON.stringify({ name: 'Jane', title: null, profile_url: null }),
    });
    await expect(extractContact(input())).resolves.toBeNull();
  });

  it('returns null on model refusal (empty string)', async () => {
    installLanguageModel({ promptResult: '   ' });
    await expect(extractContact(input())).resolves.toBeNull();
  });

  it('returns null when prompt() hangs past its AbortSignal timeout', async () => {
    installLanguageModel({ promptHangs: true });
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => AbortSignal.timeout(10));
    await expect(extractContact(input())).resolves.toBeNull();
    spy.mockRestore();
  });
});

describe('extractContact() — reconciliation (de-LinkedIn)', () => {
  it('fills name/title/message_text from the model (AI wins)', async () => {
    installLanguageModel({
      promptResult: result({
        name: 'Jane Doe',
        title: 'Head of Growth at Acme',
        message_text: 'Great to connect!',
      }),
    });
    const r = await extractContact(input());
    expect(r?.fields.name).toBe('Jane Doe');
    expect(r?.fields.title).toBe('Head of Growth at Acme');
    expect(r?.fields.message_text).toBe('Great to connect!');
  });

  it('AI null falls back to the candidate value', async () => {
    installLanguageModel({ promptResult: result({ name: 'Jane Doe' }) });
    const r = await extractContact(
      input({ candidate: candidate({ title: 'Existing Title', message_text: 'note' }) }),
    );
    expect(r?.fields.title).toBe('Existing Title');
    expect(r?.fields.message_text).toBe('note');
  });

  it('candidate wins for a clean https URL on ANY host (no linkedin anchoring)', async () => {
    installLanguageModel({ promptResult: result({ profile_url: 'https://elsewhere.com/other' }) });
    const r = await extractContact(
      input({ candidate: candidate({ profile_url: 'https://github.com/jane' }) }),
    );
    expect(r?.fields.profile_url).toBe('https://github.com/jane');
  });

  it('AI wins for the URL when the candidate is not a clean https URL', async () => {
    installLanguageModel({
      promptResult: result({ profile_url: 'https://example.com/u/jane' }),
    });
    const r = await extractContact(input({ candidate: candidate({ profile_url: 'Premium' }) }));
    expect(r?.fields.profile_url).toBe('https://example.com/u/jane');
  });
});

describe('extractContact() — suggested_event_type (review S-1)', () => {
  it('passes a valid event type through', async () => {
    installLanguageModel({
      promptResult: result({ name: 'Jane', suggested_event_type: 'direct_message' }),
    });
    const r = await extractContact(input());
    expect(r?.suggested_event_type).toBe('direct_message');
  });

  it('coerces an unknown event type to null', async () => {
    installLanguageModel({
      promptResult: result({ name: 'Jane', suggested_event_type: 'liked_a_post' }),
    });
    const r = await extractContact(input());
    expect(r?.suggested_event_type).toBeNull();
  });

  it('keeps a null suggestion as null', async () => {
    installLanguageModel({ promptResult: result({ name: 'Jane' }) });
    const r = await extractContact(input());
    expect(r?.suggested_event_type).toBeNull();
  });
});

describe('extractContact() — session + options', () => {
  it('destroys the session after a successful extraction', async () => {
    const fake = installLanguageModel();
    await extractContact(input());
    expect(fake.calls.destroy).toBe(1);
  });

  it('passes outputLanguage to create() (silences the Chrome warning)', async () => {
    const fake = installLanguageModel();
    await extractContact(input());
    expect(fake.lastArgs.create?.outputLanguage).toBe('en');
    expect(fake.lastArgs.create?.expectedOutputs).toEqual([{ type: 'text', languages: ['en'] }]);
  });
});

describe('extractContact() — debug logging is opt-in (no PII to console by default)', () => {
  it('does NOT log the prompt or raw output when debug is unset', async () => {
    installLanguageModel({ promptResult: result({ name: 'Jane' }) });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await extractContact(input()); // debug omitted ⇒ silent
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('logs the prompt and raw output only when debug: true', async () => {
    installLanguageModel({ promptResult: result({ name: 'Jane' }) });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await extractContact(input({ debug: true }));
      const joined = spy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(joined).toContain('[extractContact] AI input prompt:');
      expect(joined).toContain('[extractContact] AI raw output:');
    } finally {
      spy.mockRestore();
    }
  });
});
