-- Knowledge layer for the Skool AI chatbot.
-- Run against your Supabase: paste into the SQL editor (local: http://127.0.0.1:54323)

-- Ensure pgvector is enabled (idempotent — no-op if already installed in any schema)
create extension if not exists vector;

-- Make the vector type findable regardless of which schema pgvector landed in
set search_path to "$user", public, extensions, vector;

-- Give service_role full access to whichever schema pgvector landed in,
-- so it can cast/insert vector values, call vector functions, etc.
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

create schema if not exists skool;
grant usage on schema skool to anon, authenticated, service_role;
grant all on all tables in schema skool to service_role;
grant all on all routines in schema skool to service_role;
alter default privileges in schema skool grant all on tables to service_role;
alter default privileges in schema skool grant all on routines to service_role;

-- Workbook sections embedded for RAG retrieval
create table if not exists skool.workbook_chunks (
  id            uuid        primary key default gen_random_uuid(),
  heading_id    text        unique,          -- Google Docs heading ID; stable upsert key
  section_title text        not null,
  anchor_link   text,                        -- deep link into the Google Doc
  content       text        not null,
  content_hash  text        not null,
  embedding     vector(768),
  embed_model   text,                        -- which model produced the embedding
  synced_at     timestamptz default now()
);

-- Add column on existing tables (idempotent for re-runs)
alter table skool.workbook_chunks
  add column if not exists embed_model text;

-- HNSW index for cosine similarity (works at any table size, unlike ivfflat)
create index if not exists workbook_chunks_embedding_idx
  on skool.workbook_chunks using hnsw (embedding vector_cosine_ops);

-- RPC used by the chatbot to retrieve relevant chunks.
-- search_path is pinned so the pgvector operators (<=>) resolve regardless
-- of whether pgvector landed in `extensions`, `public`, or its own schema.
create or replace function skool.match_workbook_chunks(
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
set search_path = skool, extensions, public, vector
as $$
  select
    section_title,
    content,
    anchor_link,
    1 - (embedding <=> query_embedding) as similarity
  from skool.workbook_chunks
  where embedding is not null
    and 1 - (embedding <=> query_embedding) >= min_similarity
  order by embedding <=> query_embedding
  limit match_count;
$$;

grant execute on function skool.match_workbook_chunks(vector, int, float) to anon, authenticated, service_role;

-- Tell PostgREST to reload its schema cache so newly added columns/functions are visible
notify pgrst, 'reload schema';
