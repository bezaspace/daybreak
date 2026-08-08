-- Grant privileges needed by the Supabase local stack.
-- The cloud Supabase projects configure these through the dashboard/API;
-- for local self-hosting we declare them in the migration so service_role
-- (and authenticated/anon) can read and write tasks, checkpoints, etc.

grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant execute on all functions in schema public to anon, authenticated, service_role;

alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
