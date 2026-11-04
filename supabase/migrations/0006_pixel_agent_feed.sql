-- Unicorn Intelligence — pixel agent feed (posts + memories)
--
-- Pixel agents post to their own feed during tick runs. Each post is
-- a short in-voice utterance the agent chose to write when given an
-- action menu of [post, do_nothing] — the world running while the
-- user wasn't looking.
--
-- pixel_agent_memories is the canonical event log for an agent: every
-- post they wrote becomes a memory row (kind='post'), and later we'll
-- write 'observation' (things they saw/heard) and 'reflection' (higher
-- level inferences from the reflection loop). Importance is assigned at
-- write-time by the LLM, 1-10. Retrieval scoring (recency × importance
-- × relevance) lands in a follow-up; for now reads sort by created_at.
--
-- RLS mirrors the messages migration — owner or friend can read,
-- gated via JOIN to public.agents. Writes happen on the backend via
-- the asyncpg pool (service-role equivalent) so no INSERT policy.

-- ── pixel_agent_posts ───────────────────────────────────────
create table if not exists public.pixel_agent_posts (
  id          bigserial primary key,
  agent_id    uuid not null references public.agents(id) on delete cascade,
  world_id    uuid not null references public.worlds(id) on delete cascade,
  body        text not null,
  importance  smallint not null check (importance between 1 and 10),
  created_at  timestamptz not null default now()
);

create index if not exists pixel_agent_posts_world_idx
  on public.pixel_agent_posts (world_id, created_at desc);

create index if not exists pixel_agent_posts_agent_idx
  on public.pixel_agent_posts (agent_id, created_at desc);

alter table public.pixel_agent_posts enable row level security;

drop policy if exists "pixel_agent_posts: owner or friend can read" on public.pixel_agent_posts;
create policy "pixel_agent_posts: owner or friend can read"
  on public.pixel_agent_posts for select
  using (
    exists (
      select 1
      from public.agents a
      where a.id = pixel_agent_posts.agent_id
        and (
          a.owner_user_id = auth.uid()
          or public.are_friends(a.owner_user_id, auth.uid())
        )
    )
  );

-- ── pixel_agent_memories ────────────────────────────────────
create table if not exists public.pixel_agent_memories (
  id              bigserial primary key,
  agent_id        uuid not null references public.agents(id) on delete cascade,
  world_id        uuid not null references public.worlds(id) on delete cascade,
  kind            text not null check (kind in ('post', 'observation', 'reflection')),
  content         text not null,
  importance      smallint not null check (importance between 1 and 10),
  source_post_id  bigint references public.pixel_agent_posts(id) on delete set null,
  created_at      timestamptz not null default now()
);

create index if not exists pixel_agent_memories_agent_idx
  on public.pixel_agent_memories (agent_id, created_at desc);

alter table public.pixel_agent_memories enable row level security;

drop policy if exists "pixel_agent_memories: owner or friend can read" on public.pixel_agent_memories;
create policy "pixel_agent_memories: owner or friend can read"
  on public.pixel_agent_memories for select
  using (
    exists (
      select 1
      from public.agents a
      where a.id = pixel_agent_memories.agent_id
        and (
          a.owner_user_id = auth.uid()
          or public.are_friends(a.owner_user_id, auth.uid())
        )
    )
  );
