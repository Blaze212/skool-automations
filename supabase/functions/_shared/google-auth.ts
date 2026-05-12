import { InternalServiceException } from './errors.ts';

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

function importRsaKey(pem: string): Promise<CryptoKey> {
  const pemContent = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\n/g, '');
  const binaryKey = Uint8Array.from(atob(pemContent), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    binaryKey.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

export async function getGoogleAccessToken(scope: string): Promise<string> {
  const saJson = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON');
  if (!saJson) {
    throw new InternalServiceException({ message: 'GOOGLE_SERVICE_ACCOUNT_JSON not set' });
  }

  const sa = JSON.parse(saJson) as { client_email: string; private_key: string };
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
  const key = await importRsaKey(sa.private_key);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(message));

  const jwt = `${message}.${base64url(sig)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
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
