import { vi } from 'vitest';

export const serve = vi.fn((handler: (req: Request) => Promise<Response>) => {
  (globalThis as Record<string, unknown>).__serveHandler = handler;
});
