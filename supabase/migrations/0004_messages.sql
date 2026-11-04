-- Unicorn Intelligence — chat messages + recent visitors view.
--
-- Messages are 1-1 between a human (auth.users) and an agent (public.agents).
-- The same row schema covers both directions: role='user' for the human's
-- turn, role='agent' for the agent's reply. user_id is always the human in
-- the conversation — for chats with a friend's agent, that's the visitor;
-- for chats with one of your own agents, it's you.
--
-- recent_visitors is a SQL view (not a materialized table) over messages —
-- the data is already there, no need for a separate write path. Surfaced
-- as the "recent visitors" panel on the owner's home world (step 9.5).

create table if not exists public.messages (
  id          bigserial primary key,
  agent_id    uuid not null references public.agents(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        text not null check (role in ('user', 'agent')),
  body        text not null,
  created_at  timestamptz not null default now()
);

create index if not exists messages_agent_user_idx
  on public.messages (agent_id, user_id, created_at);

create index if not exists messages_user_idx
  on public.messages (user_id, created_at desc);

alter table public.messages enable row level security;

-- Read: a user can see messages where (a) they are the human in the chat,
-- AND (b) either they own the agent, or they are friends with the agent's
-- owner. The friend gate matches the gate on `public.agents`.
drop policy if exists "messages: visible to participants and friends" on public.messages;
create policy "messages: visible to participants and friends"
  on public.messages for select
  using (
    user_id = auth.uid()
    and exists (
      select 1
      from public.agents a
      where a.id = messages.agent_id
        and (
          a.owner_user_id = auth.uid()
          or public.are_friends(a.owner_user_id, auth.uid())
        )
    )
  );

-- Write: same gate as read. Each row is the user's own message, and
-- they must be allowed to chat with the agent (own or friend).
drop policy if exists "messages: insert when allowed" on public.messages;
create policy "messages: insert when allowed"
  on public.messages for insert
  with check (
    user_id = auth.uid()
    and exists (
      select 1
      from public.agents a
      where a.id = messages.agent_id
        and (
          a.owner_user_id = auth.uid()
          or public.are_friends(a.owner_user_id, auth.uid())
        )
    )
  );

-- recent_visitors: distinct (visitor, world owner) pairs from messages
-- where the visitor isn't the owner. Returns the most recent message
-- timestamp for the pair so the owner's home world can show "X just
-- visited Y minutes ago".
--
-- security_invoker = on means the view runs with the *caller's* RLS
-- privileges, so the messages policy above naturally limits each
-- caller to their own data. Without it, views run with the definer's
-- privileges and bypass RLS entirely.
create or replace view public.recent_visitors
  with (security_invoker = on) as
select
    m.user_id            as visitor_user_id,
    a.owner_user_id      as owner_user_id,
    max(m.created_at)    as last_visit
from public.messages m
join public.agents a on a.id = m.agent_id
where m.role = 'user'
  and m.user_id <> a.owner_user_id
group by m.user_id, a.owner_user_id;
