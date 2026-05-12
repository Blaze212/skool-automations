import { InternalServiceException } from './errors.ts';

export interface GoogleAuthEnv {
  GOOGLE_SERVICE_ACCOUNT_JSON: string;
}

export interface GoogleAuthDeps {
  fetch: typeof globalThis.fetch;
  subtle: Pick<SubtleCrypto, 'importKey' | 'sign'>;
}

export function loadGoogleAuthEnv(): GoogleAuthEnv {
  const json = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON');
  if (!json) throw new InternalServiceException({ message: 'GOOGLE_SERVICE_ACCOUNT_JSON not set' });
  return { GOOGLE_SERVICE_ACCOUNT_JSON: json };
}

export function defaultGoogleAuthDeps(): GoogleAuthDeps {
  return { fetch: globalThis.fetch, subtle: crypto.subtle };
}

function base64url(input: string | ArrayBuffer): string {
  let base64: string;
  if (typeof input === 'string') {
    base64 = btoa(input);
  } else {
    const bytes = new Uint8Array(input);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    base64 = btoa(binary);
  }
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function importRsaKey(pem: string, subtle: Pick<SubtleCrypto, 'importKey'>): Promise<CryptoKey> {
  const pemContent = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\n/g, '');
  const binaryKey = Uint8Array.from(atob(pemContent), (c) => c.charCodeAt(0));
  return subtle.importKey(
    'pkcs8',
    binaryKey.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

export async function getGoogleAccessToken(
  scope: string,
  env: GoogleAuthEnv,
  deps: GoogleAuthDeps,
): Promise<string> {
  const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON) as {
    client_email: string;
    private_key: string;
  };
  const now = Math.floor(Date.now() / 1000);

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      iss: sa.client_email,
      scope,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  );

  const message = `${header}.${payload}`;
  const key = await importRsaKey(sa.private_key, deps.subtle);
  const sig = await deps.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(message));

  const jwt = `${message}.${base64url(sig)}`;

  const res = await deps.fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    throw new InternalServiceException({
      message: `Google OAuth token exchange failed: ${res.status}`,
    });
  }

  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}
