import { afterEach, describe, expect, it, vi } from 'vitest';
import { recover } from '../../src/ai-fallback/recover.js';
import type { RecoverInput } from '../../src/ai-fallback/types.js';
import type { PipelineEvent } from '../../src/types.js';
import {
  installLanguageModel,
  uninstallLanguageModel,
} from '../../../../tests/__mocks__/language-model.ts';

function candidate(overrides: Partial<PipelineEvent> = {}): PipelineEvent {
  return {
    api_key: '',
    event_type: 'accepted_connection',
    date: '2026-06-02',
    name: '',
    title: 'Premium',
    linkedin_url: '',
    page_url: 'https://www.linkedin.com/mynetwork/',
    message_text: '1st degree connection',
    ...overrides,
  };
}

function input(overrides: Partial<RecoverInput> = {}): RecoverInput {
  return {
    trimmedHtml: '<div>Jane Doe — Head of Growth at Acme</div>',
    candidate: candidate(),
    gaps: [{ field: 'name', code: 'missing-required', message: 'name missing' }],
    pageUrl: 'https://www.linkedin.com/mynetwork/',
    ...overrides,
  };
}

afterEach(() => {
  uninstallLanguageModel();
  vi.useRealTimers();
});

describe('recover() — never throws, returns null on every failure mode', () => {
  it('returns null when LanguageModel is absent', async () => {
    uninstallLanguageModel();
    await expect(recover(input())).resolves.toBeNull();
  });

  it('returns null when availability() throws', async () => {
    installLanguageModel({ availabilityThrows: true });
    await expect(recover(input())).resolves.toBeNull();
  });

  it.each(['unavailable', 'downloadable', 'downloading'] as const)(
    'returns null when availability is "%s"',
    async (state) => {
      installLanguageModel({ availability: state });
      await expect(recover(input())).resolves.toBeNull();
    },
  );

  it('returns null when create() throws', async () => {
    installLanguageModel({ createThrows: true });
    await expect(recover(input())).resolves.toBeNull();
  });

  it('returns null when prompt() rejects', async () => {
    installLanguageModel({ promptThrows: true });
    await expect(recover(input())).resolves.toBeNull();
  });

  it('returns null when prompt() returns invalid JSON', async () => {
    installLanguageModel({ promptResult: 'not json{' });
    await expect(recover(input())).resolves.toBeNull();
  });

  it('returns null when JSON fails the schema (wrong field type)', async () => {
    installLanguageModel({
      promptResult: JSON.stringify({
        name: 42,
        title: null,
        linkedin_url: null,
        message_text: null,
      }),
    });
    await expect(recover(input())).resolves.toBeNull();
  });

  it('returns null when JSON is missing a required field', async () => {
    installLanguageModel({
      promptResult: JSON.stringify({ name: 'Jane', title: null, linkedin_url: null }),
    });
    await expect(recover(input())).resolves.toBeNull();
  });

  it('returns null on model refusal (empty string)', async () => {
    installLanguageModel({ promptResult: '   ' });
    await expect(recover(input())).resolves.toBeNull();
  });

  it('returns null when input usage exceeds the quota (gen-2 inputQuota API)', async () => {
    installLanguageModel({ inputUsage: 9999, inputQuota: 10 });
    await expect(recover(input())).resolves.toBeNull();
  });

  it('returns null when the prompt exceeds the context window (gen-3 contextWindow API)', async () => {
    // contextWindow 6144, already 0 used, prompt needs 9000 → over budget.
    installLanguageModel({ contextWindow: 6144, contextUsage: 0, inputUsage: 9000 });
    await expect(recover(input())).resolves.toBeNull();
  });

  it('proceeds when the prompt fits the context window (gen-3 contextWindow API)', async () => {
    // contextWindow 6144, used 100, prompt needs 200 → well within budget.
    installLanguageModel({ contextWindow: 6144, contextUsage: 100, inputUsage: 200 });
    const result = await recover(input());
    expect(result).not.toBeNull();
    expect(result?.filledEvent.name).toBe('Jane Doe');
  });

  // AbortSignal.timeout is not controlled by vitest fake timers, so we stub it
  // to a tiny real duration — exercising the real abort→reject→null path fast.
  it('returns null when prompt() hangs past its AbortSignal timeout', async () => {
    installLanguageModel({ promptHangs: true });
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => AbortSignal.timeout(10));
    await expect(recover(input())).resolves.toBeNull();
    spy.mockRestore();
  });

  it('returns null when measureInputUsage() hangs past its timeout', async () => {
    // inputQuota must be set for the quota guard (and thus measureInputUsage) to run.
    installLanguageModel({ measureHangs: true, inputQuota: 100 });
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => AbortSignal.timeout(10));
    await expect(recover(input())).resolves.toBeNull();
    spy.mockRestore();
  });
});

describe('recover() — reconciliation', () => {
  it('fills name/title/message_text from the model output (AI wins)', async () => {
    installLanguageModel({
      promptResult: JSON.stringify({
        name: 'Jane Doe',
        title: 'Head of Growth at Acme',
        linkedin_url: 'https://www.linkedin.com/in/jane-doe/',
        message_text: 'Great to connect!',
      }),
    });
    const result = await recover(input());
    expect(result).not.toBeNull();
    expect(result?.filledEvent.name).toBe('Jane Doe');
    expect(result?.filledEvent.title).toBe('Head of Growth at Acme');
    expect(result?.filledEvent.message_text).toBe('Great to connect!');
    expect(result?.warnings).toEqual([]);
  });

  it('AI null falls back to the scraper value', async () => {
    installLanguageModel({
      promptResult: JSON.stringify({
        name: 'Jane Doe',
        title: null,
        linkedin_url: null,
        message_text: null,
      }),
    });
    const result = await recover(
      input({ candidate: candidate({ title: 'Existing Title', message_text: 'note' }) }),
    );
    expect(result?.filledEvent.title).toBe('Existing Title');
    expect(result?.filledEvent.message_text).toBe('note');
  });

  it('scraper wins for a valid /in/ linkedin_url even if AI differs', async () => {
    installLanguageModel({
      promptResult: JSON.stringify({
        name: 'Jane Doe',
        title: 'Head of Growth',
        linkedin_url: 'https://www.linkedin.com/in/someone-else/',
        message_text: null,
      }),
    });
    const result = await recover(
      input({ candidate: candidate({ linkedin_url: 'https://www.linkedin.com/in/jane-doe/' }) }),
    );
    expect(result?.filledEvent.linkedin_url).toBe('https://www.linkedin.com/in/jane-doe/');
  });

  it('AI wins for linkedin_url when the scraper value is not a canonical /in/ URL', async () => {
    installLanguageModel({
      promptResult: JSON.stringify({
        name: 'Jane Doe',
        title: 'Head of Growth',
        linkedin_url: 'https://www.linkedin.com/in/jane-doe/',
        message_text: null,
      }),
    });
    const result = await recover(input({ candidate: candidate({ linkedin_url: 'Premium' }) }));
    expect(result?.filledEvent.linkedin_url).toBe('https://www.linkedin.com/in/jane-doe/');
  });

  it('destroys the session after a successful recovery', async () => {
    const fake = installLanguageModel();
    await recover(input());
    expect(fake.calls.destroy).toBe(1);
  });
});
