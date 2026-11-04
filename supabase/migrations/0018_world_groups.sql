-- Pixel Societies — Worlds (joinable group spaces)
--
-- Distinct from public.worlds (which is each user's home world,
-- one-per-user). This new layer is shared spaces that multiple users
-- join to mingle their agents — the "Hogwarts dining hall" to the
-- home world's bedroom. Schema mirrors friendships: invite/accept,
-- bidirectional confirmation.
--
-- world_groups          — the space itself
-- world_group_members   — who's joined (pending → accepted → left)
-- agent_conversations.world_group_id — society conversations can now
--                          belong to a group instead of a home world
--
-- Society auto-Spark cadence will diverge: home worlds quiet, group
-- worlds loud. That split is enforced in agent_society.py, not here.

-- ── world_groups ────────────────────────────────────────────────────
create table if not exists public.world_groups (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  description   text,
  -- Short shareable identifier for join links (e.g. "owl-pub-3").
  slug          text not null unique
                check (slug ~ '^[a-z0-9][a-z0-9-]{2,40}$'),
  visibility    text not null default 'invite_only'
                check (visibility in ('invite_only', 'public')),
  created_by    uuid not null references auth.users(id) on delete cascade,
  created_at    timestamptz not null default now()
);

create index if not exists world_groups_created_by_idx
  on public.world_groups (created_by);

create index if not exists world_groups_visibility_idx
  on public.world_groups (visibility)
  where visibility = 'public';

-- ── world_group_members ─────────────────────────────────────────────
create table if not exists public.world_group_members (
  id            uuid primary key default gen_random_uuid(),
  group_id      uuid not null references public.world_groups(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  status        text not null default 'pending'
                check (status in ('pending', 'accepted', 'left')),
  invited_by    uuid references auth.users(id),
  invited_at    timestamptz default now(),
  joined_at     timestamptz,
  unique (group_id, user_id)
);

create index if not exists world_group_members_user_idx
  on public.world_group_members (user_id, status);
create index if not exists world_group_members_group_idx
  on public.world_group_members (group_id, status);

-- Helper: is `user_id` an accepted member of `group_id`?
create or replace function public.is_world_group_member(
  p_group_id uuid, p_user_id uuid
)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.world_group_members m
     where m.group_id = p_group_id
       and m.user_id = p_user_id
       and m.status = 'accepted'
  )
$$;

-- ── agent_conversations: world_group_id ─────────────────────────────
alter table public.agent_conversations
  add column if not exists world_group_id uuid
    references public.world_groups(id) on delete cascade;

create index if not exists agent_conversations_world_group_idx
  on public.agent_conversations (world_group_id, last_message_at desc nulls last)
  where world_group_id is not null;

-- A conversation belongs to either a home world OR a group, not both.
-- Drop existing world_id NOT NULL via a tolerant check (since v0
-- conversations all have world_id, this is forward-only).
alter table public.agent_conversations
  alter column world_id drop not null;

alter table public.agent_conversations
  add constraint agent_conversations_scope_xor
    check ((world_id is not null)::int + (world_group_id is not null)::int = 1);

-- ── RLS — world_groups ──────────────────────────────────────────────
alter table public.world_groups enable row level security;

drop policy if exists "world_groups: members or public can read"
  on public.world_groups;
create policy "world_groups: members or public can read"
  on public.world_groups for select
  using (
    visibility = 'public'
    or created_by = auth.uid()
    or public.is_world_group_member(id, auth.uid())
  );

drop policy if exists "world_groups: anyone can create"
  on public.world_groups;
create policy "world_groups: anyone can create"
  on public.world_groups for insert
  with check (created_by = auth.uid());

drop policy if exists "world_groups: creator can update"
  on public.world_groups;
create policy "world_groups: creator can update"
  on public.world_groups for update
  using (created_by = auth.uid());

drop policy if exists "world_groups: creator can delete"
  on public.world_groups;
create policy "world_groups: creator can delete"
  on public.world_groups for delete
  using (created_by = auth.uid());

-- ── RLS — world_group_members ───────────────────────────────────────
alter table public.world_group_members enable row level security;

-- A user can read membership rows where they're the user, OR the row
-- is in a group they're already an accepted member of (so they can
-- see who else is in their group), OR they created the group.
drop policy if exists "world_group_members: own or fellow members can read"
  on public.world_group_members;
create policy "world_group_members: own or fellow members can read"
  on public.world_group_members for select
  using (
    user_id = auth.uid()
    or public.is_world_group_member(group_id, auth.uid())
    or exists (
      select 1 from public.world_groups g
       where g.id = group_id and g.created_by = auth.uid()
    )
  );

-- A user can join (insert their own row) when:
--   • they're inserting their own user_id, AND
--   • the group is public (self-join), OR
--   • they're being invited by a member (handled at insert time —
--     enforce in app code; RLS just gates the user_id check).
-- For v0 we allow self-joins to any group; invite-only is enforced by
-- the create-invite endpoint inserting on the inviter's behalf via
-- service role. Tighten once invite UI lands.
drop policy if exists "world_group_members: self insert"
  on public.world_group_members;
create policy "world_group_members: self insert"
  on public.world_group_members for insert
  with check (user_id = auth.uid());

-- A user can update their own membership (e.g. accept invite, leave).
drop policy if exists "world_group_members: self update"
  on public.world_group_members;
create policy "world_group_members: self update"
  on public.world_group_members for update
  using (user_id = auth.uid());

-- A user can remove their own membership; group creator can remove any.
drop policy if exists "world_group_members: self or creator can delete"
  on public.world_group_members;
create policy "world_group_members: self or creator can delete"
  on public.world_group_members for delete
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.world_groups g
       where g.id = group_id and g.created_by = auth.uid()
    )
  );

-- ── RLS — extend agent_conversations and messages for groups ────────
-- Existing read policy was scoped to home-world owner-or-friend. Add
-- group-membership as another path. Drop and recreate so the check
-- list is one expression.

drop policy if exists "agent_conversations: owner or friend can read"
  on public.agent_conversations;
create policy "agent_conversations: owner, friend, or group member can read"
  on public.agent_conversations for select
  using (
    (world_id is not null and exists (
      select 1 from public.worlds w
       where w.id = agent_conversations.world_id
         and (
           w.owner_user_id = auth.uid()
           or public.are_friends(w.owner_user_id, auth.uid())
         )
    ))
    or
    (world_group_id is not null and public.is_world_group_member(
      world_group_id, auth.uid()
    ))
  );

drop policy if exists "agent_conv_messages: owner or friend can read"
  on public.agent_conversation_messages;
create policy "agent_conv_messages: owner, friend, or group member can read"
  on public.agent_conversation_messages for select
  using (
    exists (
      select 1 from public.agent_conversations c
       where c.id = agent_conversation_messages.conversation_id
         and (
           (c.world_id is not null and exists (
             select 1 from public.worlds w
              where w.id = c.world_id
                and (
                  w.owner_user_id = auth.uid()
                  or public.are_friends(w.owner_user_id, auth.uid())
                )
           ))
           or
           (c.world_group_id is not null and public.is_world_group_member(
             c.world_group_id, auth.uid()
           ))
         )
    )
  );

-- ── Realtime publication ────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.world_groups;
    exception when duplicate_object then null;
    end;
    begin
      alter publication supabase_realtime add table public.world_group_members;
    exception when duplicate_object then null;
    end;
  end if;
end $$;
