---
name: new-migration
description: >
  Create and apply a new Supabase database migration for the CareerSystems
  project. Use this skill whenever the user wants to add a table, column, index,
  RLS policy, or any schema change. Also trigger when implementing a spec that
  requires schema changes, adding a foreign key, or modifying existing table
  structure. Covers file naming, safe SQL patterns, local application via the
  Supabase CLI, and TypeScript type regeneration.
---

# New Migration Skill

This skill walks through creating and applying a Supabase migration correctly —
using the CLI (never raw psql), naming files consistently, and keeping the TS
types in sync.

**Workspace root:** `/Users/barton/workspaces/careersystems/workspace`

---

## Step 1 — Understand the schema change

Before writing SQL, collect:

1. **What's changing?** (new table / new column / new index / RLS policy / other)
2. **Table name(s)** involved
3. **Who accesses this data?** — members via anon/authenticated role, or service
   role only (admin/internal)?
4. **Does it need to be rolled back cleanly?** — if yes, write a `-- down` comment
   block at the bottom (not executed, just documented)

Read relevant existing migrations in `supabase/migrations/` to understand naming
conventions and patterns already in use.

---

## Step 2 — Name the file

Migration files use a zero-padded incrementing prefix so they apply in order:

```
supabase/migrations/<NNN>_<short-description>.sql
```

Find the highest existing number and increment by 1:

```bash
ls supabase/migrations/ | sort | tail -5
```

Example: if the highest is `054_resume_parse_status.sql`, create `055_<description>.sql`.

Use a concise snake_case description that describes what the migration does,
not the ticket number — e.g. `055_add_job_match_scores.sql`.

---

## Step 3 — Write the SQL

### Safe patterns to follow

**New table:**

```sql
create table if not exists public.<table_name> (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- index on user_id for common lookup pattern
create index if not exists <table_name>_user_id_idx on public.<table_name>(user_id);
```

**New column:**

```sql
alter table public.<table_name>
  add column if not exists <col_name> <type> [not null] [default <value>];
```

**RLS (enable + policies):**

```sql
alter table public.<table_name> enable row level security;

-- members can read their own rows
create policy "<table_name>_select_own"
  on public.<table_name> for select
  using (auth.uid() = user_id);

-- members can insert their own rows
create policy "<table_name>_insert_own"
  on public.<table_name> for insert
  with check (auth.uid() = user_id);
```

**Service-role-only table (no member access):**

```sql
alter table public.<table_name> enable row level security;
-- no policies = only service role can access
```

### Things to avoid

- Don't use `drop table` or `drop column` without a preceding `if exists` guard
- Don't add `not null` columns to existing tables without a `default` value
  (this will lock the table in prod)
- Don't use `serial` — use `uuid` + `gen_random_uuid()` as the default

---

## Step 4 — Apply locally

**Always use the Supabase CLI — never `psql -f migration.sql`** (that bypasses
migration tracking).

```bash
supabase migration up --db-url postgresql://postgres:postgres@127.0.0.1:54322/postgres
```

If Supabase isn't running locally:

```bash
supabase start
```

Confirm the migration applied by checking:

```bash
supabase migration list
```

The new migration should show as "applied".

---

## Step 5 — Regenerate TypeScript types

After the migration applies, regenerate the types so edge functions and the portal
pick up the schema changes:

```bash
pnpm supabase gen types typescript --local > packages/supabase-types/src/database.types.ts
```

(Check the exact output path — it may vary. Look for the existing `database.types.ts`
file with `Glob` if unsure.)

---

## Step 6 — Write the ADR

Create `docs/adr/<YYYY-MM-DD>-<short-description>.md` following the template in
`docs/architecture_decision_record.md`. Cover:

- **Context:** why the schema change is needed
- **Decision:** what was added/changed and why
- **Consequences:** performance implications, RLS access pattern, migration risk

---

## Step 7 — Verify

```bash
pnpm typecheck    # confirm types compile after regeneration
pnpm format
pnpm lint
```

---

## Checklist

- [ ] Migration file named with timestamp prefix
- [ ] SQL uses safe `if not exists` guards
- [ ] RLS enabled on any new table (even if no policies yet)
- [ ] Applied with `supabase migration up` (not raw psql)
- [ ] `supabase migration list` shows it as applied
- [ ] TypeScript types regenerated
- [ ] `pnpm typecheck` passes
- [ ] ADR created in `docs/adr/`

---

## Deployment note

Migrations are deployed to production automatically via CI on push to `main`.
**Never run `supabase db push`** — that pushes unapplied local migrations directly
to the production database, bypassing the PR review process.
