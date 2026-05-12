import { describe, expect, it, vi } from 'vitest';
import { FractionalDb } from '../../../supabase/functions/_shared/db/fractional.ts';

function makeMockClient(insertResult = { data: { id: 'row-uuid' }, error: null }) {
  const single = vi.fn().mockResolvedValue(insertResult);
  const select = vi.fn(() => ({ single }));
  const insert = vi.fn(() => ({ select }));
  const eq = vi.fn().mockResolvedValue({ data: null, error: null });
  const update = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ insert, update }));
  return {
    client: { from } as ReturnType<typeof from>,
    mocks: { from, insert, update, select, single, eq },
  };
}

describe('FractionalDb', () => {
  describe('insertClient', () => {
    it('inserts and returns the new client id', async () => {
      const { client, mocks } = makeMockClient({ data: { id: 'client-uuid' }, error: null });
      const db = new FractionalDb(client as never);

      const id = await db.insertClient({
        full_name: 'Jane Doe',
        drive_email: 'jane@example.com',
        skool_email: 'jane@example.com',
        program_start_date: '2026-06-01',
        notes: null,
      });

      expect(id).toBe('client-uuid');
      expect(mocks.from).toHaveBeenCalledWith('fractional_clients');
      expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ full_name: 'Jane Doe' }));
    });

    it('throws when the DB returns an error', async () => {
      const { client } = makeMockClient({ data: null, error: new Error('unique violation') });
      const db = new FractionalDb(client as never);

      await expect(
        db.insertClient({
          full_name: 'Jane',
          drive_email: 'j@e.com',
          skool_email: 'j@e.com',
          program_start_date: null,
          notes: null,
        }),
      ).rejects.toThrow('unique violation');
    });
  });

  describe('insertWorkflowRun', () => {
    it('inserts with status running and returns the run id', async () => {
      const { client, mocks } = makeMockClient({ data: { id: 'run-uuid' }, error: null });
      const db = new FractionalDb(client as never);

      const id = await db.insertWorkflowRun('client-uuid', 'onboard');

      expect(id).toBe('run-uuid');
      expect(mocks.from).toHaveBeenCalledWith('fractional_workflow_runs');
      expect(mocks.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          client_id: 'client-uuid',
          workflow: 'onboard',
          status: 'running',
        }),
      );
    });

    it('throws when the DB returns an error', async () => {
      const { client } = makeMockClient({ data: null, error: new Error('fk violation') });
      const db = new FractionalDb(client as never);

      await expect(db.insertWorkflowRun('bad-id', 'onboard')).rejects.toThrow('fk violation');
    });
  });

  describe('completeWorkflowRun', () => {
    it('updates status to complete', async () => {
      const { client, mocks } = makeMockClient();
      const db = new FractionalDb(client as never);

      await db.completeWorkflowRun('run-uuid');

      expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'complete' }));
      expect(mocks.eq).toHaveBeenCalledWith('id', 'run-uuid');
    });
  });

  describe('failWorkflowRun', () => {
    it('updates status to failed with the error message', async () => {
      const { client, mocks } = makeMockClient();
      const db = new FractionalDb(client as never);

      await db.failWorkflowRun('run-uuid', 'something went wrong');

      expect(mocks.update).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          error: 'something went wrong',
        }),
      );
      expect(mocks.eq).toHaveBeenCalledWith('id', 'run-uuid');
    });
  });
});
