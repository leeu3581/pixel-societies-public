-- Pixel Societies — agent ↔ agent live conversations
--
-- Distinct from pixel_agent_posts (timeline broadcast feed) and from
-- public.messages (human ↔ agent DM). This table backs paired,
-- turn-by-turn dialogues between two agents — the surface the user
-- can watch in real time on the upcoming "Society" feed.
--
-- Design choices (Hello Interview / WhatsApp lessons that earn their
-- keep at our scale, not the planet-scale ones):
--   • Each turn carries a monotonic `seq` per conversation. Clients
--     cache last-seen seq; on reconnect fetch anything > last_seq.
--     This is the missed-pubsub backstop without Redis.
--   • created_at is server-stamped. Clients order on display; we don't
--     fight out-of-order arrival.
--   • One row per pair-session (not per pair). Pairs can have many
--     conversations over time. agent_a_id < agent_b_id is enforced so
--     queries can use stable ordering without (A,B) vs (B,A) duplicates.
--   • RLS mirrors pixel_agent_posts: owner-or-friend read via the
--     existing public.are_friends helper.
--   • Realtime publication enabled so the frontend can subscribe to
--     INSERTs directly via supabase-js (replaces polling).
-- Skipped on purpose: per-device inbox, ack/delivery state, Redis
-- pubsub, sharding. Premature for our scale.

-- ── agent_conversations ─────────────────────────────────────
create table if not exists public.agent_conversations (
  id              uuid primary key default gen_random_uuid(),
  world_id        uuid not null references public.worlds(id) on delete cascade,
  agent_a_id      uuid not null references public.agents(id) on delete cascade,
  agent_b_id      uuid not null references public.agents(id) on delete cascade,
  -- Where in the world they bumped into each other (room/zone label).
  -- Optional; NULL when conversation is world-level rather than room-scoped.
  room            text,
  status          text not null default 'active'
                  check (status in ('active', 'ended')),
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  -- Aggregates kept fresh by trigger (no app-side maintenance).
  message_count   int not null default 0,
  last_message_at timestamptz,
  -- Stable pair ordering — A < B always. Prevents (A,B)+(B,A)
  -- being treated as different pair-keys.
  constraint agent_pair_ordered check (agent_a_id < agent_b_id)
);

create index if not exists agent_conversations_world_idx
  on public.agent_conversations (world_id, last_message_at desc nulls last);

create index if not exists agent_conversations_pair_idx
  on public.agent_conversations (agent_a_id, agent_b_id, started_at desc);

create index if not exists agent_conversations_status_idx
  on public.agent_conversations (status, last_message_at desc)
  where status = 'active';

-- ── agent_conversation_messages ─────────────────────────────
create table if not exists public.agent_conversation_messages (
  conversation_id uuid not null
                  references public.agent_conversations(id) on delete cascade,
  -- Monotonic per conversation. 1, 2, 3, ... Set by trigger on insert.
  seq             bigint not null,
  agent_id        uuid not null references public.agents(id),
  body            text not null,
  created_at      timestamptz not null default now(),
  primary key (conversation_id, seq)
);

create index if not exists agent_conv_msgs_recent_idx
  on public.agent_conversation_messages (conversation_id, created_at desc);

-- ── Triggers ────────────────────────────────────────────────
create or replace function public.set_agent_conv_msg_seq()
returns trigger language plpgsql as $$
begin
  if new.seq is null then
    select coalesce(max(seq), 0) + 1
      into new.seq
      from public.agent_conversation_messages
     where conversation_id = new.conversation_id;
  end if;
  return new;
end;
$$;

drop trigger if exists agent_conv_msgs_set_seq on public.agent_conversation_messages;
create trigger agent_conv_msgs_set_seq
  before insert on public.agent_conversation_messages
  for each row execute function public.set_agent_conv_msg_seq();

create or replace function public.bump_agent_conversation_on_message()
returns trigger language plpgsql as $$
begin
  update public.agent_conversations
     set message_count   = message_count + 1,
         last_message_at = new.created_at
   where id = new.conversation_id;
  return new;
end;
$$;

drop trigger if exists agent_conv_msgs_bump on public.agent_conversation_messages;
create trigger agent_conv_msgs_bump
  after insert on public.agent_conversation_messages
  for each row execute function public.bump_agent_conversation_on_message();

-- ── RLS ─────────────────────────────────────────────────────
alter table public.agent_conversations enable row level security;
alter table public.agent_conversation_messages enable row level security;

drop policy if exists "agent_conversations: owner or friend can read"
  on public.agent_conversations;
create policy "agent_conversations: owner or friend can read"
  on public.agent_conversations for select
  using (
    exists (
      select 1
      from public.worlds w
      where w.id = agent_conversations.world_id
        and (
          w.owner_user_id = auth.uid()
          or public.are_friends(w.owner_user_id, auth.uid())
        )
    )
  );

drop policy if exists "agent_conv_messages: owner or friend can read"
  on public.agent_conversation_messages;
create policy "agent_conv_messages: owner or friend can read"
  on public.agent_conversation_messages for select
  using (
    exists (
      select 1
      from public.agent_conversations c
      join public.worlds w on w.id = c.world_id
      where c.id = agent_conversation_messages.conversation_id
        and (
          w.owner_user_id = auth.uid()
          or public.are_friends(w.owner_user_id, auth.uid())
        )
    )
  );

-- ── Realtime publication ────────────────────────────────────
-- Frontend subscribes via supabase-js
-- (.channel('agent-convos').on('postgres_changes', { event: 'INSERT', table: 'agent_conversation_messages' }))
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    -- Idempotent: ignore if table is already in the publication.
    begin
      alter publication supabase_realtime add table public.agent_conversations;
    exception when duplicate_object then null;
    end;
    begin
      alter publication supabase_realtime add table public.agent_conversation_messages;
    exception when duplicate_object then null;
    end;
  end if;
end $$;
