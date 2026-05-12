import { vi } from 'vitest';

const child = vi.fn(() => ({
  info: vi.fn(),
  error: vi.fn(),
  child,
}));

const logger = {
  info: vi.fn(),
  error: vi.fn(),
  child,
};

export default vi.fn(() => logger);
