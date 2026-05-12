-- Rename skool schema to internal_cs
alter schema skool rename to internal_cs;

-- Recreate the match function with updated search_path and table reference
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

notify pgrst, 'reload schema';
