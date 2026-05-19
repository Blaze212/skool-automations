export function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

export function loadEnv<const K extends string>(keys: K[]): Record<K, string> {
  return Object.fromEntries(keys.map((k) => [k, requireEnv(k)])) as Record<K, string>;
}
