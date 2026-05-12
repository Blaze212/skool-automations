import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    setupFiles: ['tests/integration/globalSetup.ts'],
    testTimeout: 15000,
  },
  resolve: {
    alias: {
      // Resolve Deno-style ESM imports to real npm packages for integration tests
      'https://deno.land/std@0.168.0/http/server.ts': resolve(
        __dirname,
        'tests/__mocks__/deno-serve.ts',
      ),
      'https://esm.sh/@supabase/supabase-js@2': resolve(
        __dirname,
        'node_modules/@supabase/supabase-js',
      ),
      'npm:pino': resolve(__dirname, 'tests/__mocks__/pino.ts'),
    },
  },
});
