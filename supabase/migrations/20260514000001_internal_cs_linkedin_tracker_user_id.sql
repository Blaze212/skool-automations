ALTER TABLE internal_cs.linkedin_tracker_clients
  ADD COLUMN user_id uuid;

ALTER TABLE internal_cs.linkedin_tracker_clients
  ADD CONSTRAINT linkedin_tracker_clients_user_id_key UNIQUE (user_id);

CREATE OR REPLACE FUNCTION internal_cs.provision_linkedin_tracker(
  p_user_id uuid,
  p_sheet_id text
) RETURNS TABLE (api_key text, sheet_id text) LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  INSERT INTO internal_cs.linkedin_tracker_clients (user_id, sheet_id, api_key)
  VALUES (p_user_id, p_sheet_id, gen_random_uuid()::text)
  ON CONFLICT (user_id) DO UPDATE SET sheet_id = EXCLUDED.sheet_id
  RETURNING linkedin_tracker_clients.api_key, linkedin_tracker_clients.sheet_id;
END;
$$;

notify pgrst, 'reload schema';
