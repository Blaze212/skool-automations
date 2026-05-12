-- pgvector
create extension if not exists vector;

set search_path to "$user", public, extensions, vector;

do $$
declare
  vec_schema text;
begin
  select n.nspname into vec_schema
  from pg_extension e
  join pg_namespace n on e.extnamespace = n.oid
  where e.extname = 'vector';

  if vec_schema is not null then
    execute format('grant usage on schema %I to anon, authenticated', vec_schema);
    execute format('grant all on schema %I to service_role', vec_schema);
    execute format('grant all on all tables in schema %I to service_role', vec_schema);
    execute format('grant all on all sequences in schema %I to service_role', vec_schema);
    execute format('grant all on all routines in schema %I to service_role', vec_schema);
    execute format('alter default privileges in schema %I grant all on tables to service_role', vec_schema);
    execute format('alter default privileges in schema %I grant all on sequences to service_role', vec_schema);
    execute format('alter default privileges in schema %I grant all on routines to service_role', vec_schema);
  end if;
end $$;

-- internal_cs schema (Skool AI chatbot knowledge layer)
create schema if not exists internal_cs;
grant usage on schema internal_cs to anon, authenticated, service_role;
grant all on all tables in schema internal_cs to service_role;
grant all on all routines in schema internal_cs to service_role;
alter default privileges in schema internal_cs grant all on tables to service_role;
alter default privileges in schema internal_cs grant all on routines to service_role;

create table if not exists internal_cs.workbook_chunks (
  id            uuid        primary key default gen_random_uuid(),
  heading_id    text        unique,
  section_title text        not null,
  anchor_link   text,
  content       text        not null,
  content_hash  text        not null,
  embedding     vector(768),
  embed_model   text,
  synced_at     timestamptz default now()
);

create index if not exists workbook_chunks_embedding_idx
  on internal_cs.workbook_chunks using hnsw (embedding vector_cosine_ops);

create or replace function internal_cs.match_workbook_chunks(
  query_embedding vector(768),
  match_count     int   default 3,
  min_similarity  float default 0.4
)
returns table (
  section_title text,
  content       text,
  anchor_link   text,
  similarity    float
)
language sql stable
set search_path = internal_cs, extensions, public, vector
as $$
  select
    section_title,
    content,
    anchor_link,
    1 - (embedding <=> query_embedding) as similarity
  from internal_cs.workbook_chunks
  where embedding is not null
    and 1 - (embedding <=> query_embedding) >= min_similarity
  order by embedding <=> query_embedding
  limit match_count;
$$;

grant execute on function internal_cs.match_workbook_chunks(vector, int, float) to anon, authenticated, service_role;

-- fractional advisory automation tables (internal_cs schema)
create table if not exists internal_cs.fractional_clients (
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

alter table internal_cs.fractional_clients enable row level security;

create table if not exists internal_cs.fractional_workflow_runs (
  id           uuid        primary key default gen_random_uuid(),
  client_id    uuid        references internal_cs.fractional_clients(id),
  workflow     text        not null,
  status       text        not null check (status in ('pending', 'running', 'complete', 'failed')),
  error        text,
  started_at   timestamptz,
  completed_at timestamptz
);

alter table internal_cs.fractional_workflow_runs enable row level security;

notify pgrst, 'reload schema';
