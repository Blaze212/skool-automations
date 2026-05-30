import { vi } from 'vitest';

(globalThis as Record<string, unknown>).chrome = {
  storage: {
    sync: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
    },
    local: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    onChanged: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  },
  runtime: {
    id: 'test-extension-id',
    sendMessage: vi.fn(),
    getManifest: vi.fn().mockReturnValue({ version: '1.0.0' }),
    onMessage: {
      addListener: vi.fn(),
    },
    onMessageExternal: {
      addListener: vi.fn(),
    },
    onConnectExternal: {
      addListener: vi.fn(),
    },
    onInstalled: {
      addListener: vi.fn(),
    },
    onStartup: {
      addListener: vi.fn(),
    },
  },
  sidePanel: {
    setPanelBehavior: vi.fn().mockResolvedValue(undefined),
  },
  action: {
    setBadgeText: vi.fn().mockResolvedValue(undefined),
    setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
    setBadgeTextColor: vi.fn().mockResolvedValue(undefined),
  },
  alarms: {
    create: vi.fn(),
    onAlarm: {
      addListener: vi.fn(),
    },
  },
};
