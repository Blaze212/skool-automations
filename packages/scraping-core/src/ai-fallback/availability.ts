/**
 * Cached wrapper around LanguageModel.availability() (spec 013, D-AI-7).
 *
 * Each availability() call is non-trivial and the state does not change
 * second-to-second, so we cache for 5 minutes. The cache is invalidated when
 * the user toggles ai_fallback_enabled or after a model download completes
 * (callers invoke invalidateAvailabilityCache()).
 *
 * Never throws: a thrown or absent LanguageModel resolves to 'unavailable'.
 */

import type { AiAvailability } from './types.js';

const CACHE_TTL_MS = 5 * 60 * 1000;

let cached: { value: AiAvailability; at: number } | null = null;

async function probe(): Promise<AiAvailability> {
  try {
    if (typeof LanguageModel === 'undefined' || !LanguageModel) return 'unavailable';
    return await LanguageModel.availability();
  } catch {
    return 'unavailable';
  }
}

export async function getCachedAvailability(): Promise<AiAvailability> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.value;
  const value = await probe();
  cached = { value, at: now };
  return value;
}

export function invalidateAvailabilityCache(): void {
  cached = null;
}
