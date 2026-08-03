-- Phase 6 M4: tenant isolation and per-tenant quotas

create table if not exists tenants (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  value text not null,
  config jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create unique index if not exists idx_tenants_type_value on tenants(type, value);

create table if not exists tenant_memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id) on delete cascade not null,
  user_id text not null,
  role text not null default 'viewer',
  created_at timestamptz default now(),
  unique (tenant_id, user_id)
);

alter table if exists tasks
  add column if not exists tenant_id uuid references tenants(id) on delete set null;

alter table if exists workspaces
  add column if not exists tenant_id uuid references tenants(id) on delete set null;

-- Backfill a default tenant for existing tasks that do not have one
insert into tenants (type, value, config)
select distinct 'repo', repo, '{}'::jsonb
from tasks
where tenant_id is null
  and not exists (select 1 from tenants t where t.type = 'repo' and t.value = tasks.repo)
on conflict (type, value) do nothing;

update tasks
set tenant_id = (select id from tenants where type = 'repo' and value = tasks.repo)
where tenant_id is null;
