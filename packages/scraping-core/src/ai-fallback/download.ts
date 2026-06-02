/**
 * Model download trigger for the settings UI (spec 013, Phase 6).
 *
 * The Prompt API model (~2 GB) is NOT auto-downloaded — the user opts in via a
 * UI button, which calls this. Creating a session with a download monitor
 * starts the fetch and reports progress; we destroy the throwaway session once
 * the weights are present and resolve with the post-download availability.
 *
 * Never throws: any failure resolves to 'unavailable'. Keeps every
 * LanguageModel.* reference inside the ai-fallback module (spec 013 CI guard #1).
 */

import type { AiAvailability } from './types.js';
import { getCachedAvailability, invalidateAvailabilityCache } from './availability.js';

export async function downloadModel(
  onProgress?: (fraction: number) => void,
): Promise<AiAvailability> {
  try {
    if (typeof LanguageModel === 'undefined' || !LanguageModel) return 'unavailable';
    const session = await LanguageModel.create({
      expectedOutputs: [{ type: 'text', languages: ['en'] }],
      monitor(monitor) {
        monitor.addEventListener('downloadprogress', (event) => onProgress?.(event.loaded));
      },
    });
    session.destroy?.();
    invalidateAvailabilityCache();
    return await getCachedAvailability();
  } catch {
    invalidateAvailabilityCache();
    return 'unavailable';
  }
}
