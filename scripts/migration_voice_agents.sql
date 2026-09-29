create table public.voice_agents (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  variant text not null check (variant in ('emergency-service', 'inspection-estimate')),
  retell_agent_id text,
  retell_phone_number text,
  notification_email text,
  google_calendar_id text,
  google_refresh_token text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.voice_agents enable row level security;
-- No policies added: anon/authenticated roles get zero access by default.
-- Edge functions use the service_role key, which bypasses RLS entirely, so
-- this table (including the OAuth refresh token) is never reachable from the
-- browser/client apps, only from server-side function code.
