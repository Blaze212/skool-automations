Migrations are managed in the career-systems private github repo.
The backend DB is shared so that we can easily access prod data for internal data queries.

Write and keep all migrations here, but note that they are copies and in order to update
prod you will need to push a CR with the migrations in https://github.com/Blaze212/career-systems

These migrations are user to locally test and the port config is setup such that supabase will not conflict between the two project if running both locally.

@agents create files in this with a datetime prefix, and once migrated into the sister repo they will be replaced with a XXX\_ prefix since that is the naming convention, but we dont have access to that here.
