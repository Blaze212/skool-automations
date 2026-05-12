import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getGoogleAccessToken,
  GoogleAuthDeps,
  GoogleAuthEnv,
} from '../../../supabase/functions/_shared/google-auth.ts';

const TEST_ENV: GoogleAuthEnv = {
  // Valid base64 content so atob() doesn't throw during PEM parsing
  GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
    client_email: 'test@project.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n',
  }),
};

function makeDeps(overrides: Partial<GoogleAuthDeps> = {}): GoogleAuthDeps {
  return {
    fetch: vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ access_token: 'ya29.test-token' }),
    }),
    subtle: {
      importKey: vi.fn().mockResolvedValue({ type: 'private' } as CryptoKey),
      sign: vi.fn().mockResolvedValue(new Uint8Array(32).buffer),
    },
    ...overrides,
  };
}

describe('getGoogleAccessToken', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the access token from Google', async () => {
    const token = await getGoogleAccessToken(
      'https://www.googleapis.com/auth/drive',
      TEST_ENV,
      makeDeps(),
    );
    expect(token).toBe('ya29.test-token');
  });

  it('posts to the Google token endpoint', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ access_token: 'ya29.test-token' }),
    });
    await getGoogleAccessToken('scope', TEST_ENV, makeDeps({ fetch: mockFetch }));
    expect(mockFetch).toHaveBeenCalledWith(
      'https://oauth2.googleapis.com/token',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('throws when token exchange returns non-200', async () => {
    const deps = makeDeps({
      fetch: vi.fn().mockResolvedValue({ ok: false, status: 401 }),
    });
    await expect(getGoogleAccessToken('scope', TEST_ENV, deps)).rejects.toThrow(
      'Google OAuth token exchange failed: 401',
    );
  });
});
