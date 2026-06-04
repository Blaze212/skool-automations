import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getCachedAvailability,
  invalidateAvailabilityCache,
} from '../../src/ai-fallback/availability.js';
import {
  installLanguageModel,
  uninstallLanguageModel,
} from '../../../../tests/__mocks__/language-model.ts';

describe('getCachedAvailability', () => {
  beforeEach(() => {
    invalidateAvailabilityCache();
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    uninstallLanguageModel();
    invalidateAvailabilityCache();
  });

  it('returns "unavailable" when LanguageModel is absent', async () => {
    uninstallLanguageModel();
    expect(await getCachedAvailability()).toBe('unavailable');
  });

  it('returns "unavailable" when availability() throws', async () => {
    installLanguageModel({ availabilityThrows: true });
    expect(await getCachedAvailability()).toBe('unavailable');
  });

  it('passes through the model availability state', async () => {
    installLanguageModel({ availability: 'downloadable' });
    expect(await getCachedAvailability()).toBe('downloadable');
  });

  it('passes outputLanguage to availability() (silences Chrome warning on load)', async () => {
    const fake = installLanguageModel({ availability: 'available' });
    await getCachedAvailability();
    expect(fake.lastArgs.availability).toEqual({ outputLanguage: 'en' });
  });

  it('caches the result for 5 minutes', async () => {
    const fake = installLanguageModel({ availability: 'available' });
    expect(await getCachedAvailability()).toBe('available');
    expect(await getCachedAvailability()).toBe('available');
    expect(fake.calls.availability).toBe(1);

    // Just under the 5-min TTL — still cached.
    vi.setSystemTime(5 * 60 * 1000 - 1);
    expect(await getCachedAvailability()).toBe('available');
    expect(fake.calls.availability).toBe(1);

    // Past the TTL — re-probes.
    vi.setSystemTime(5 * 60 * 1000 + 1);
    expect(await getCachedAvailability()).toBe('available');
    expect(fake.calls.availability).toBe(2);
  });

  it('re-probes after invalidateAvailabilityCache()', async () => {
    const fake = installLanguageModel({ availability: 'available' });
    await getCachedAvailability();
    expect(fake.calls.availability).toBe(1);
    invalidateAvailabilityCache();
    await getCachedAvailability();
    expect(fake.calls.availability).toBe(2);
  });
});
