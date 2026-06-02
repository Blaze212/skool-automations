/**
 * Test double for Chrome's built-in `LanguageModel` Prompt API (spec 013).
 *
 * Tests install a fake global via installLanguageModel(...) and remove it with
 * uninstallLanguageModel(). The fake lets each test script availability, the
 * create()/prompt()/measureInputUsage() behavior, and assert call counts.
 */

import type {
  AiAvailability,
  LanguageModelSession,
  LanguageModelStatic,
} from '../../packages/scraping-core/src/ai-fallback/types.ts';

export interface FakeLanguageModelConfig {
  availability?: AiAvailability | (() => Promise<AiAvailability>);
  /** Throw from availability() to exercise the never-throws guard. */
  availabilityThrows?: boolean;
  /** Throw from create(). */
  createThrows?: boolean;
  /** Reject from prompt() (sync throw modeled as rejected promise). */
  promptThrows?: boolean;
  /** Hang prompt() forever so the AbortSignal timeout is what resolves it. */
  promptHangs?: boolean;
  /** The string prompt() resolves with (defaults to a valid JSON payload). */
  promptResult?: string;
  /** measureInputUsage() return value. */
  inputUsage?: number;
  /** Throw from measureInputUsage(). */
  measureThrows?: boolean;
  /** Hang measureInputUsage() so its AbortSignal timeout resolves it. */
  measureHangs?: boolean;
  /** Reported session.inputQuota. */
  inputQuota?: number;
}

export interface FakeLanguageModel extends LanguageModelStatic {
  calls: {
    availability: number;
    create: number;
    prompt: number;
    measure: number;
    destroy: number;
  };
}

const DEFAULT_RESULT = JSON.stringify({
  name: 'Jane Doe',
  title: 'Head of Growth at Acme',
  linkedin_url: 'https://www.linkedin.com/in/jane-doe/',
  message_text: null,
});

function hangUntilAborted<T>(signal: AbortSignal | undefined): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    if (!signal) return; // never settles
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  });
}

export function createFakeLanguageModel(config: FakeLanguageModelConfig = {}): FakeLanguageModel {
  const calls = { availability: 0, create: 0, prompt: 0, measure: 0, destroy: 0 };

  const fake: FakeLanguageModel = {
    calls,
    async availability(): Promise<AiAvailability> {
      calls.availability++;
      if (config.availabilityThrows) throw new Error('availability boom');
      const a = config.availability ?? 'available';
      return typeof a === 'function' ? a() : a;
    },
    async create(options): Promise<LanguageModelSession> {
      calls.create++;
      if (config.createThrows) throw new Error('create boom');
      options?.signal?.throwIfAborted?.();

      const session: LanguageModelSession = {
        inputQuota: config.inputQuota,
        async measureInputUsage(_input, opts): Promise<number> {
          calls.measure++;
          if (config.measureThrows) throw new Error('measure boom');
          if (config.measureHangs) return hangUntilAborted<number>(opts?.signal);
          return config.inputUsage ?? 1;
        },
        async prompt(_input, opts): Promise<string> {
          calls.prompt++;
          if (config.promptThrows) throw new Error('prompt boom');
          if (config.promptHangs) return hangUntilAborted<string>(opts?.signal);
          return config.promptResult ?? DEFAULT_RESULT;
        },
        destroy(): void {
          calls.destroy++;
        },
      };
      return session;
    },
  };
  return fake;
}

export function installLanguageModel(config: FakeLanguageModelConfig = {}): FakeLanguageModel {
  const fake = createFakeLanguageModel(config);
  (globalThis as { LanguageModel?: LanguageModelStatic }).LanguageModel = fake;
  return fake;
}

export function uninstallLanguageModel(): void {
  delete (globalThis as { LanguageModel?: LanguageModelStatic }).LanguageModel;
}
