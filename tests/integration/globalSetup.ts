import { execSync } from 'child_process';

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  let output: string;
  try {
    output = execSync('npx supabase status --output env', { encoding: 'utf-8' });
  } catch {
    output = '';
  }

  // Output uses SERVICE_ROLE_KEY with quoted values: SERVICE_ROLE_KEY="eyJ..."
  const match = output.match(/^SERVICE_ROLE_KEY="([^"]+)"/m);
  if (match) {
    process.env.SUPABASE_SERVICE_ROLE_KEY = match[1];
  }
}
