import { beforeEach, describe, expect, it, vi } from 'vitest';

const denoEnvGet = vi.fn();
vi.stubGlobal('Deno', { env: { get: denoEnvGet } });

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const mockCryptoKey = { type: 'private' };
vi.stubGlobal('crypto', {
  subtle: {
    importKey: vi.fn().mockResolvedValue(mockCryptoKey),
    sign: vi.fn().mockResolvedValue(new Uint8Array(32).buffer),
  },
});

import { getGoogleAccessToken } from '../../../supabase/functions/_shared/google-auth.ts';

// Valid base64 string so atob() doesn't throw during PEM parsing in tests
const TEST_SA_JSON = JSON.stringify({
  client_email: 'test@project.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n',
});

describe('getGoogleAccessToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    denoEnvGet.mockReturnValue(TEST_SA_JSON);
    (crypto.subtle.importKey as ReturnType<typeof vi.fn>).mockResolvedValue(mockCryptoKey);
    (crypto.subtle.sign as ReturnType<typeof vi.fn>).mockResolvedValue(new Uint8Array(32).buffer);
  });

  it('returns the access token from Google', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ access_token: 'ya29.test-token' }),
    });

    const token = await getGoogleAccessToken('https://www.googleapis.com/auth/drive');

    expect(token).toBe('ya29.test-token');
  });

  it('posts to the Google token endpoint', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ access_token: 'ya29.test-token' }),
    });

    await getGoogleAccessToken('https://www.googleapis.com/auth/drive');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://oauth2.googleapis.com/token',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('throws when GOOGLE_SERVICE_ACCOUNT_JSON is not set', async () => {
    denoEnvGet.mockReturnValue(undefined);

    await expect(getGoogleAccessToken('scope')).rejects.toThrow(
      'GOOGLE_SERVICE_ACCOUNT_JSON not set',
    );
  });

  it('throws when token exchange returns non-200', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    });

    await expect(getGoogleAccessToken('scope')).rejects.toThrow(
      'Google OAuth token exchange failed: 401',
    );
  });
});
