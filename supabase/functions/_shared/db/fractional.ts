import type { createAdminClient } from '../supabase-admin.ts'

type DbClient = ReturnType<typeof createAdminClient>

export interface InsertClientData {
  full_name: string
  drive_email: string
  skool_email: string
  program_start_date: string | null
  notes: string | null
}

export class FractionalDb {
  constructor(private readonly db: DbClient) {}

  async insertClient(data: InsertClientData): Promise<string> {
    const { data: row, error } = await this.db
      .from('fractional_clients')
      .insert(data)
      .select('id')
      .single()
    if (error) throw error
    return row.id
  }

  async insertWorkflowRun(clientId: string, workflow: string): Promise<string> {
    const { data: row, error } = await this.db
      .from('fractional_workflow_runs')
      .insert({ client_id: clientId, workflow, status: 'running', started_at: new Date().toISOString() })
      .select('id')
      .single()
    if (error) throw error
    return row.id
  }

  async completeWorkflowRun(runId: string): Promise<void> {
    await this.db
      .from('fractional_workflow_runs')
      .update({ status: 'complete', completed_at: new Date().toISOString() })
      .eq('id', runId)
  }

  async failWorkflowRun(runId: string, errorMessage: string): Promise<void> {
    await this.db
      .from('fractional_workflow_runs')
      .update({ status: 'failed', error: errorMessage, completed_at: new Date().toISOString() })
      .eq('id', runId)
  }
}
