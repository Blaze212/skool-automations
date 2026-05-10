import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
  },
  resolve: {
    alias: {
      'https://deno.land/std@0.168.0/http/server.ts': resolve(
        __dirname,
        'tests/__mocks__/deno-serve.ts',
      ),
      'https://esm.sh/@supabase/supabase-js@2': resolve(
        __dirname,
        'tests/__mocks__/supabase-js.ts',
      ),
      'npm:pino': resolve(__dirname, 'tests/__mocks__/pino.ts'),
    },
  },
})
