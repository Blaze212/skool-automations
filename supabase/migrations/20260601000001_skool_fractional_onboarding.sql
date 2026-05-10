create schema if not exists internal_automations;

grant usage on schema internal_automations to service_role;
grant all on all tables in schema internal_automations to service_role;
alter default privileges in schema internal_automations grant all on tables to service_role;

create table if not exists internal_automations.fractional_clients (
  id                 uuid        primary key default gen_random_uuid(),
  full_name          text        not null,
  drive_email        text        not null,
  skool_email        text        not null,
  trello_card_id     text,
  drive_folder_id    text,
  workbook_doc_id    text,
  skool_member_id    text,
  program_start_date date,
  notes              text,
  created_at         timestamptz default now()
);

alter table internal_automations.fractional_clients enable row level security;

create table if not exists internal_automations.fractional_workflow_runs (
  id           uuid        primary key default gen_random_uuid(),
  client_id    uuid        references internal_automations.fractional_clients(id),
  workflow     text        not null,
  status       text        not null check (status in ('pending', 'running', 'complete', 'failed')),
  error        text,
  started_at   timestamptz,
  completed_at timestamptz
);

alter table internal_automations.fractional_workflow_runs enable row level security;

notify pgrst, 'reload schema';
