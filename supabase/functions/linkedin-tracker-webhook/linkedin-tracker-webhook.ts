import { createAdminClient } from '../_shared/supabase-admin.ts';
import { createGoogleSheetsClient } from '../_shared/google-sheets.ts';
import {
  AccessDeniedException,
  errorBody,
  logError,
  normalizeError,
  ValidationException,
} from '../_shared/errors.ts';
import { logger } from '../_shared/logger.ts';

interface DebugPayload {
  button_aria_label: string;
  button_text: string;
  container_html: string;
  page_url: string;
}

interface RequestBody {
  api_key: string;
  date: string;
  name: string;
  title: string;
  company: string;
  message_type: 'Connection Request' | 'Direct Message';
  message_text: string;
  status: 'Sent';
  debug?: DebugPayload;
}

function formatDate(iso: string): string {
  const [year, month, day] = iso.split('-');
  return `${parseInt(month)}/${parseInt(day)}/${year}`;
}

function validateBody(body: Partial<RequestBody>): RequestBody {
  const required = ['api_key', 'date', 'name', 'message_type', 'status'] as const;
  for (const field of required) {
    if (!body[field]) {
      throw new ValidationException({ message: `Missing required field: ${field}` });
    }
  }
  return body as RequestBody;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  try {
    const log = logger.child({ fn: 'linkedin-tracker-webhook' });

    try {
      const raw = await req.json().catch(() => {
        throw new ValidationException({ message: 'Request body must be valid JSON' });
      });

      const body = validateBody(raw as Partial<RequestBody>);

      const db = createAdminClient('internal_cs');
      const { data: client, error } = await db
        .from('linkedin_tracker_clients')
        .select('sheet_id')
        .eq('api_key', body.api_key)
        .single();

      if (error || !client) {
        throw new AccessDeniedException({ message: 'Unknown api_key' });
      }

      const { sheet_id } = client as { sheet_id: string };

      if (body.debug) {
        log.info({ debug: body.debug }, 'debug payload received');
      }

      const formattedDate = formatDate(body.date);
      const row = [
        '',
        '',
        '',
        '',
        body.name,
        body.title,
        '',
        body.message_type,
        formattedDate,
        'Sent',
        body.message_text,
      ];

      const sheets = createGoogleSheetsClient();
      await sheets.appendRow(sheet_id, 'Outreach Log!A:K', row);

      log.info(
        {
          api_key_prefix: body.api_key.slice(0, 8),
          sheet_id,
          message_type: body.message_type,
          name: body.name,
        },
        'linkedin-tracker-webhook: row appended',
      );

      return json({ success: true }, 200);
    } catch (err) {
      const normalized = logError(err as Error, 'linkedin-tracker-webhook failed');
      return json(errorBody(normalized), normalized.status);
    }
  } catch (err) {
    console.error('linkedin-tracker-webhook: unhandled framework error', err);
    const normalized = normalizeError(err as Error);
    return json(errorBody(normalized), 500);
  }
}
