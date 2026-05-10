import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createAdminClient } from '../_shared/supabase-admin.ts'
import { errorBody, logError, normalizeError, ValidationException } from '../_shared/errors.ts'
import { logger } from '../_shared/logger.ts'

serve(async (req: Request) => {
  // Outer catch: framework panics / Deno runtime crashes
  try {
    const secret = Deno.env.get('WEBHOOK_SECRET')
    const incoming = req.headers.get('X-Webhook-Secret')
    if (!secret || incoming !== secret) {
      return new Response('Unauthorized', { status: 401 })
    }

    const log = logger.child({ fn: 'fractional-form-webhook' })
    let runId: string | null = null

    // Inner catch: all normal application errors
    try {
      const body = await req.json().catch(() => {
        throw new ValidationException({ message: 'Request body must be valid JSON' })
      })

      const d = body.data ?? {}
      const clientName = d['Client full name']?.[0]?.trim()
      const driveEmail = d['Email for Google Drive sharing']?.[0]?.trim()
      const skoolEmailRaw = d['Email for Skool (leave blank if same as Drive email)']?.[0]?.trim()
      const skoolEmail = skoolEmailRaw || driveEmail
      const startDate = d['Program start date']?.[0]?.trim() || null
      const notes = d['Notes']?.[0]?.trim() || null

      if (!clientName || !driveEmail) {
        throw new ValidationException({ message: 'Missing required fields: client name or drive email' })
      }

      log.info({ clientName, driveEmail }, 'request received')

      const supabase = createAdminClient('internal_automations')

      const { data: client, error: clientErr } = await supabase
        .from('fractional_clients')
        .insert({ full_name: clientName, drive_email: driveEmail, skool_email: skoolEmail,
                  program_start_date: startDate, notes })
        .select('id')
        .single()

      if (clientErr) throw clientErr

      const { data: run, error: runErr } = await supabase
        .from('fractional_workflow_runs')
        .insert({ client_id: client.id, workflow: 'onboard', status: 'running',
                  started_at: new Date().toISOString() })
        .select('id')
        .single()

      if (runErr) throw runErr
      runId = run.id

      await supabase
        .from('fractional_workflow_runs')
        .update({ status: 'complete', completed_at: new Date().toISOString() })
        .eq('id', runId)

      log.info({ runId }, 'onboarding workflow run complete')

      // Always 200 — Apps Script does not retry on non-200
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    } catch (err) {
      const normalized = logError(err as Error, 'fractional-form-webhook failed', { runId })

      if (runId) {
        const supabase = createAdminClient('internal_automations')
        await supabase
          .from('fractional_workflow_runs')
          .update({ status: 'failed', error: normalized.message,
                    completed_at: new Date().toISOString() })
          .eq('id', runId)
          .catch(() => {}) // best-effort — don't mask the original error
      }

      // Always 200 — Apps Script does not retry on non-200
      return new Response(JSON.stringify(errorBody(normalized)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  } catch (err) {
    console.error('fractional-form-webhook: unhandled framework error', err)
    const normalized = normalizeError(err as Error)
    return new Response(JSON.stringify(errorBody(normalized)), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
