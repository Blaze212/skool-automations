import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { loadSupabaseServiceEnv } from './env.ts';

export function createAdminClient(schema = 'public') {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = loadSupabaseServiceEnv();
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
    db: { schema },
  });
}
