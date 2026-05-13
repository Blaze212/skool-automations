create table if not exists internal_cs.linkedin_tracker_clients (
  id          uuid primary key default gen_random_uuid(),
  api_key     text unique not null,
  sheet_id    text not null,
  label       text,
  created_at  timestamptz default now()
);

alter table internal_cs.linkedin_tracker_clients enable row level security;

notify pgrst, 'reload schema';
