function require(name: string): string {
  const val = Deno.env.get(name)
  if (!val) throw new Error(`Missing required env var: ${name}`)
  return val
}

export function loadSupabaseEnv() {
  return {
    SUPABASE_URL: require('SUPABASE_URL'),
    SUPABASE_ANON_KEY: require('SUPABASE_ANON_KEY'),
  }
}

export function loadSupabaseServiceEnv() {
  return {
    SUPABASE_URL: require('SUPABASE_URL'),
    SUPABASE_SERVICE_ROLE_KEY: require('SUPABASE_SERVICE_ROLE_KEY'),
  }
}
