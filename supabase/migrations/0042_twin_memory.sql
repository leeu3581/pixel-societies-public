-- Private source evidence is backend-only. No direct client access, even to owners.
create table public.twin_memory_state (
 owner_user_id uuid primary key references public.profiles(id) on delete cascade,
 revision integer not null default 0,
 analyzed_revision integer not null default -1,
 status text not null default 'empty' check (status in ('empty','pending','analyzing','ready','failed')),
 snapshot jsonb not null default '{}',
 reviews jsonb not null default '{}',
 error text,
 updated_at timestamptz not null default now()
);
create table public.twin_memory_sources (
 id uuid primary key default gen_random_uuid(),
 owner_user_id uuid not null references public.profiles(id) on delete cascade,
 source_key text not null,
 kind text not null check (kind in ('claude_code','gmail','manual','legacy')),
 label text not null,
 payload jsonb not null,
 created_at timestamptz not null default now(),
 unique(owner_user_id,source_key)
);
create table public.twin_discovery_signals (
 id uuid primary key default gen_random_uuid(),
 owner_user_id uuid not null references public.profiles(id) on delete cascade,
 group_id uuid not null references public.world_groups(id) on delete cascade,
 insight_id text not null,
 approved_revision integer not null,
 purpose text not null check (purpose in ('help','collaborate','cofounder')),
 kind text not null,
 title text not null,
 body text not null,
 topics text[] not null default '{}',
 availability text not null,
 expires_at timestamptz not null,
 source_ids uuid[] not null default '{}',
 created_at timestamptz not null default now(),
 unique(owner_user_id, group_id, insight_id, purpose)
);
create table public.twin_introductions (
 id uuid primary key default gen_random_uuid(),
 owner_user_id uuid not null references public.profiles(id) on delete cascade,
 group_id uuid not null references public.world_groups(id) on delete cascade,
 signal_a uuid not null references public.twin_discovery_signals(id) on delete cascade,
 signal_b uuid not null references public.twin_discovery_signals(id) on delete cascade,
 created_at timestamptz not null default now(),
 unique(owner_user_id, signal_a, signal_b)
);
create table public.twin_introduction_feedback (
 introduction_id uuid not null references public.twin_introductions(id) on delete cascade,
 owner_user_id uuid not null references public.profiles(id) on delete cascade,
 outcome text not null,
 note text not null default '',
 updated_at timestamptz not null default now(),
 primary key(introduction_id, owner_user_id)
);
-- Preserve legacy private text before removing it from shared personas.
insert into public.twin_memory_sources(owner_user_id,source_key,kind,label,payload)
 select owner_user_id,'legacy:'||id,'legacy','Earlier imported memory',
 jsonb_build_object('text',substring(persona_md from '(?s)<!-- claude-code-memory:start -->(.*?)<!-- claude-code-memory:end -->'))
 from public.agents where owner_user_id is not null
 and persona_md like '%<!-- claude-code-memory:start -->%'
 on conflict(owner_user_id,source_key) do nothing;
update public.agents set persona_md=regexp_replace(persona_md,
 '(?s)<!-- claude-code-memory:start -->.*?<!-- claude-code-memory:end -->', '', 'g')
 where persona_md like '%<!-- claude-code-memory:start -->%';
insert into public.twin_memory_state(owner_user_id,revision,status)
 select distinct owner_user_id,1,'pending' from public.twin_memory_sources
 on conflict do nothing;
update public.agents a set subtitle='Builder' from public.builder_profiles bp
 where bp.agent_id=a.id and a.subtitle=bp.headline
 and exists(select 1 from public.twin_memory_sources s where s.owner_user_id=a.owner_user_id and s.kind='legacy');
-- Imported activity is private. Only explicit discovery grants may be shared.
drop policy if exists "builder_profiles: self or co-member can read" on public.builder_profiles;
create policy "builder_profiles: owner read" on public.builder_profiles for select using(owner_user_id=auth.uid());
-- Old numerical matches are retired, including direct PostgREST reads.
revoke all on public.matches from anon, authenticated;
-- All new table access goes through authenticated backend handlers.
alter table public.twin_memory_state enable row level security;
alter table public.twin_memory_sources enable row level security;
alter table public.twin_discovery_signals enable row level security;
alter table public.twin_introductions enable row level security;
alter table public.twin_introduction_feedback enable row level security;
revoke all on public.twin_memory_state,public.twin_memory_sources,public.twin_discovery_signals,
 public.twin_introductions,public.twin_introduction_feedback from public,anon,authenticated;
create index twin_memory_sources_owner on public.twin_memory_sources(owner_user_id);
create index twin_discovery_group on public.twin_discovery_signals(group_id,expires_at);
