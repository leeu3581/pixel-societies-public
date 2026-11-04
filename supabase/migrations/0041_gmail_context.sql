-- Credentials and pending context are backend-only, never readable via PostgREST.
create table public.gmail_connections (
 owner_user_id uuid primary key references public.profiles(id) on delete cascade,
 refresh_token text not null,
 generation uuid not null default gen_random_uuid(),
 last_sync_at timestamptz,
 last_error text
);
create table public.gmail_oauth_states (
 owner_user_id uuid primary key references public.profiles(id) on delete cascade,
 state_hash text unique not null,
 verifier text not null,
 expires_at timestamptz not null
);
create table public.gmail_context_previews (
 owner_user_id uuid primary key references public.profiles(id) on delete cascade,
 id uuid not null default gen_random_uuid(),
 generation uuid not null,
 context jsonb not null,
 expires_at timestamptz not null
);
create table public.twin_source_context (
 owner_user_id uuid not null references public.profiles(id) on delete cascade,
 source text not null check (source = 'gmail'),
 agent_id uuid not null references public.agents(id) on delete cascade,
 context jsonb not null,
 updated_at timestamptz not null default now(),
 primary key (owner_user_id, source)
);
-- No client policies: all operations require the authenticated backend owner checks.
alter table public.gmail_connections enable row level security;
alter table public.gmail_oauth_states enable row level security;
alter table public.gmail_context_previews enable row level security;
alter table public.twin_source_context enable row level security;
revoke all on public.gmail_connections, public.gmail_oauth_states, public.gmail_context_previews, public.twin_source_context from public, anon, authenticated;
