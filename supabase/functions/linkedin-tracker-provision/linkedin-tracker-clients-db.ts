import { createAdminClient } from '../_shared/supabase-admin.ts';
import { InternalServiceException, ResourceNotFoundException } from '../_shared/errors.ts';

export type ProvisionRow = { api_key: string; sheet_id: string };

export class LinkedInTrackerClientsDb {
  private db: ReturnType<typeof createAdminClient>;

  constructor() {
    this.db = createAdminClient('internal_cs');
  }

  async getByUserId(userId: string): Promise<ProvisionRow> {
    const { data, error } = await this.db
      .from('linkedin_tracker_clients')
      .select('api_key, sheet_id')
      .eq('user_id', userId)
      .single();

    if (error) {
      if ((error as { code?: string }).code === 'PGRST116') {
        throw new ResourceNotFoundException({ message: 'No provision found for this user' });
      }
      throw new InternalServiceException({
        message: 'DB query failed',
        sourceError: error as Error,
      });
    }

    return data as ProvisionRow;
  }

  async provision(userId: string, sheetId: string): Promise<ProvisionRow> {
    const { data, error } = await this.db.rpc('provision_linkedin_tracker', {
      p_user_id: userId,
      p_sheet_id: sheetId,
    });

    if (error || !data || !(data as ProvisionRow[]).length) {
      throw new InternalServiceException({
        message: 'DB provision failed',
        sourceError: error as Error,
      });
    }

    return (data as ProvisionRow[])[0];
  }
}
