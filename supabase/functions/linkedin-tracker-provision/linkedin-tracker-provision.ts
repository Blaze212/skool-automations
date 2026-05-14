import { createAdminClient } from '../_shared/supabase-admin.ts';
import {
  AccessDeniedException,
  errorBody,
  InternalServiceException,
  logError,
  normalizeError,
  ValidationException,
} from '../_shared/errors.ts';
import { logger } from '../_shared/logger.ts';
import { LinkedInTrackerClientsDb } from './linkedin-tracker-clients-db.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': 'https://app.cmcareersystems.com',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const SHEET_ID_RE = /^[a-zA-Z0-9_-]{10,}$/;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function extractJwt(req: Request): string {
  const auth = req.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) {
    throw new AccessDeniedException({ message: 'Missing or invalid Authorization header' });
  }
  return auth.slice(7);
}

async function resolveUser(jwtToken: string): Promise<string> {
  const client = createAdminClient();
  const { data, error } = await client.auth.getUser(jwtToken);
  if (error) {
    const status = (error as { status?: number }).status;
    if (status === 401) {
      throw new AccessDeniedException({
        message: 'Invalid or expired token',
        sourceError: error as Error,
      });
    }
    throw new InternalServiceException({
      message: 'Auth service error',
      sourceError: error as Error,
    });
  }
  if (!data.user) {
    throw new AccessDeniedException({ message: 'Invalid or expired token' });
  }
  return data.user.id;
}

function requireServiceAccountEmail(): string {
  const email = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_EMAIL');
  if (!email) {
    throw new InternalServiceException({ message: 'GOOGLE_SERVICE_ACCOUNT_EMAIL not configured' });
  }
  return email;
}

const log = logger.child({ fn: 'linkedin-tracker-provision' });

async function handleGet(userId: string, db: LinkedInTrackerClientsDb): Promise<Response> {
  const row = await db.getByUserId(userId);
  const serviceAccountEmail = requireServiceAccountEmail();
  log.info(
    { userId, api_key_prefix: row.api_key.slice(0, 8) },
    'linkedin-tracker-provision: GET hit',
  );
  return json(
    {
      api_key: row.api_key,
      sheet_id: row.sheet_id,
      service_account_email: serviceAccountEmail,
    },
    200,
  );
}

async function handlePost(
  req: Request,
  userId: string,
  db: LinkedInTrackerClientsDb,
): Promise<Response> {
  const raw = await req.json().catch(() => {
    throw new ValidationException({ message: 'Request body must be valid JSON' });
  });

  const sheetId = (raw as Record<string, unknown>).sheet_id;
  if (!sheetId || typeof sheetId !== 'string' || !sheetId.trim()) {
    throw new ValidationException({ message: 'Missing required field: sheet_id' });
  }
  if (!SHEET_ID_RE.test(sheetId)) {
    throw new ValidationException({
      message: `Invalid sheet_id format: ${sheetId} does not match the required pattern`,
    });
  }

  const serviceAccountEmail = requireServiceAccountEmail();
  const result = await db.provision(userId, sheetId);
  log.info(
    { userId, api_key_prefix: result.api_key.slice(0, 8) },
    'linkedin-tracker-provision: POST success',
  );
  return json(
    {
      api_key: result.api_key,
      sheet_id: result.sheet_id,
      service_account_email: serviceAccountEmail,
    },
    200,
  );
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  try {
    try {
      const jwtToken = extractJwt(req);
      const userId = await resolveUser(jwtToken);
      log.info({ userId, method: req.method }, 'linkedin-tracker-provision: request received');

      const db = new LinkedInTrackerClientsDb();

      if (req.method === 'GET') return await handleGet(userId, db);
      if (req.method === 'POST') return await handlePost(req, userId, db);

      throw new ValidationException({ message: 'Method not allowed' });
    } catch (err) {
      const normalized = logError(err as Error, 'linkedin-tracker-provision failed');
      return json(errorBody(normalized), normalized.status);
    }
  } catch (err) {
    console.error('linkedin-tracker-provision: unhandled framework error', err);
    const normalized = normalizeError(err as Error);
    return json(errorBody(normalized), 500);
  }
}
