-- pixel/instinct — L1 structured layer + co-founder matching
--
-- Two tables:
--   builder_profiles — the deterministic "what this person actually
--     builds" signal, derived from a Claude Code history export. One row
--     per agent (the agent IS the twin). No LLM in this path; every
--     field is computed from cwd / gitBranch / timestamps / file
--     extensions.
--   matches — scored, de-duplicated pairs with human-readable evidence.
--     Stage 1 (cheap, deterministic) writes these; a later LLM stage can
--     enrich `rationale` without touching the score.
--
-- Numbering note: this repo has shipped colliding migration numbers
-- before (two different 0027_*.sql on separate branches → the ledger
-- recorded one and silently skipped the other). Versions 0028–0034 are
-- already recorded on dev databases from unmerged branches, so this
-- stream deliberately starts at 0040.

-- ── builder_profiles ────────────────────────────────────────────────
create table if not exists public.builder_profiles (
  id             uuid primary key default gen_random_uuid(),
  agent_id       uuid not null references public.agents(id) on delete cascade,
  owner_user_id  uuid not null references auth.users(id)    on delete cascade,

  -- Structured behavioural signal (all deterministic).
  projects       jsonb  not null default '[]'::jsonb,  -- [{name, fingerprint, sessions, branches, first_seen, last_seen}]
  stacks         text[] not null default '{}',         -- ['typescript','python','postgres']
  domains        text[] not null default '{}',         -- ['devtools','fintech','agents']
  tools          text[] not null default '{}',         -- tools/MCPs actually used
  cadence        jsonb  not null default '{}'::jsonb,  -- {active_days, sessions_per_week, hour_histogram, longest_streak_days}

  -- Derived, used directly by the matcher.
  role_lean      text,          -- 'infra' | 'interface' | 'product' | 'research' | 'generalist'
  headline       text,          -- one line: "what they build"

  source         text not null default 'claude_code',
  total_sessions integer not null default 0,
  span_days      integer not null default 0,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint builder_profiles_agent_key unique (agent_id),
  constraint builder_profiles_role_lean_check check (
    role_lean is null or role_lean in
      ('infra','interface','product','research','generalist')
  )
);

create index if not exists builder_profiles_owner_idx
  on public.builder_profiles (owner_user_id);
create index if not exists builder_profiles_stacks_idx
  on public.builder_profiles using gin (stacks);
create index if not exists builder_profiles_domains_idx
  on public.builder_profiles using gin (domains);

-- ── matches ─────────────────────────────────────────────────────────
create table if not exists public.matches (
  id          uuid primary key default gen_random_uuid(),
  group_id    uuid not null references public.world_groups(id) on delete cascade,
  agent_a     uuid not null references public.agents(id) on delete cascade,
  agent_b     uuid not null references public.agents(id) on delete cascade,

  score       numeric(6,3) not null,
  -- [{kind:'shared_domain', text:'both spent weeks on transcript ingestion'}, …]
  evidence    jsonb not null default '[]'::jsonb,
  rationale   text,                       -- optional LLM-written summary
  status      text not null default 'suggested',

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- Canonical ordering makes (A,B) and (B,A) the same row.
  constraint matches_pair_order  check (agent_a < agent_b),
  constraint matches_pair_unique unique (group_id, agent_a, agent_b),
  constraint matches_status_check check (
    status in ('suggested','surfaced','accepted','dismissed')
  )
);

create index if not exists matches_group_score_idx
  on public.matches (group_id, score desc);
create index if not exists matches_agent_a_idx on public.matches (agent_a);
create index if not exists matches_agent_b_idx on public.matches (agent_b);

-- ── RLS ─────────────────────────────────────────────────────────────
-- The FastAPI backend connects as `postgres` and bypasses RLS; these
-- policies exist so anon/authenticated clients (supabase-js) can only
-- ever see what they should.

alter table public.builder_profiles enable row level security;

-- Read: your own profile, or the profile of any agent that shares an
-- accepted group membership with you.
drop policy if exists "builder_profiles: self or co-member can read"
  on public.builder_profiles;
create policy "builder_profiles: self or co-member can read"
  on public.builder_profiles for select
  using (
    owner_user_id = auth.uid()
    or exists (
      select 1
        from public.world_group_members mine
        join public.world_group_members theirs
          on theirs.group_id = mine.group_id
       where mine.user_id   = auth.uid()
         and mine.status    = 'accepted'
         and theirs.user_id = public.builder_profiles.owner_user_id
         and theirs.status  = 'accepted'
    )
  );

-- Write: owner only. (Backend bypasses RLS and does the real writes.)
drop policy if exists "builder_profiles: owner can write"
  on public.builder_profiles;
create policy "builder_profiles: owner can write"
  on public.builder_profiles for all
  using (owner_user_id = auth.uid())
  with check (owner_user_id = auth.uid());

alter table public.matches enable row level security;

-- Read: any accepted member of the group the match belongs to.
drop policy if exists "matches: group members can read" on public.matches;
create policy "matches: group members can read"
  on public.matches for select
  using (
    exists (
      select 1 from public.world_group_members m
       where m.group_id = public.matches.group_id
         and m.user_id  = auth.uid()
         and m.status   = 'accepted'
    )
  );
