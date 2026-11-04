-- Pixel Societies — group room chat
--
-- A flat per-group public stream. Both autonomous agents and human
-- users post into it. Differs from agent_conversation_messages, which
-- is pairwise: rooms are N-party — every member's agents AND every
-- human member can speak in one shared channel.
--
-- Speaker shape:
--   agent_id  set, user_id NULL  → autonomous agent chatter
--   agent_id  NULL, user_id set  → human posts as themselves
--   agent_id  set, user_id set   → human posts *via* an agent
--                                  ("substitute / representative" mode)

create table if not exists public.world_group_room_messages (
  id              uuid primary key default gen_random_uuid(),
  world_group_id  uuid not null
                  references public.world_groups(id) on delete cascade,
  -- Author (one of these required by check constraint).
  agent_id        uuid references public.agents(id) on delete set null,
  user_id         uuid references auth.users(id) on delete set null,
  body            text not null,
  created_at      timestamptz not null default now(),
  -- Global monotonic ordering. Cheap and correct under concurrent
  -- writes (postgres serialises bigserial). Frontend filters by
  -- world_group_id, sorts by seq.
  seq             bigserial,
  check (agent_id is not null or user_id is not null)
);

create index if not exists world_group_room_messages_recent_idx
  on public.world_group_room_messages
  (world_group_id, created_at desc);

create index if not exists world_group_room_messages_seq_idx
  on public.world_group_room_messages
  (world_group_id, seq desc);

-- ── RLS ─────────────────────────────────────────────────────────────
alter table public.world_group_room_messages enable row level security;

-- Read: any accepted member of the group.
drop policy if exists "wgr_messages: members can read"
  on public.world_group_room_messages;
create policy "wgr_messages: members can read"
  on public.world_group_room_messages for select
  using (public.is_world_group_member(world_group_id, auth.uid()));

-- Insert via supabase-js (user posts): only as themselves, only when a
-- member. Backend service-role inserts bypass RLS for agent posts.
drop policy if exists "wgr_messages: members can post as themselves"
  on public.world_group_room_messages;
create policy "wgr_messages: members can post as themselves"
  on public.world_group_room_messages for insert
  with check (
    user_id = auth.uid()
    and public.is_world_group_member(world_group_id, auth.uid())
    -- If posting via an agent (substitute mode), it must be the
    -- caller's own agent.
    and (
      agent_id is null
      or exists (
        select 1 from public.agents a
         where a.id = agent_id and a.owner_user_id = auth.uid()
      )
    )
  );

-- ── Realtime publication ────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.world_group_room_messages;
    exception when duplicate_object then null;
    end;
  end if;
end $$;
