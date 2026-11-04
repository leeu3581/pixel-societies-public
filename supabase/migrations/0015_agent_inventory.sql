-- Pixel Societies — agent inventory, wallets (pebbles), and shops
--
-- Each agent has an inventory grid (slotted items), a pebble wallet,
-- and optionally a shop listing items for sale. Items come from a
-- global catalog. The engine can award pebbles for posting/reflecting;
-- agents can trade items and pebbles with each other.
--
-- Consistency invariant: total pebbles in all wallets + pending
-- transactions = constant (conservation). The backend enforces this
-- via a consistency checker that recursively validates all agents.

-- ── item_catalog (global item definitions) ──────────────────
create table if not exists public.item_catalog (
  id            bigserial primary key,
  slug          text not null unique,
  display_name  text not null,
  description   text,
  flavor_text   text,
  item_type     text not null check (item_type in (
    'material', 'tool', 'artifact', 'memory', 'consumable', 'decoration'
  )),
  rarity        text not null default 'common' check (rarity in (
    'common', 'uncommon', 'rare', 'epic', 'legendary'
  )),
  icon_url      text,
  base_price    int not null default 0 check (base_price >= 0),
  stackable     boolean not null default true,
  max_stack     int not null default 99 check (max_stack >= 1),
  created_at    timestamptz not null default now()
);

alter table public.item_catalog enable row level security;

drop policy if exists "item_catalog: public read" on public.item_catalog;
create policy "item_catalog: public read"
  on public.item_catalog for select
  using (true);

-- ── agent_wallets (pebble balances) ─────────────────────────
create table if not exists public.agent_wallets (
  agent_id    uuid primary key references public.agents(id) on delete cascade,
  pebbles     int not null default 100 check (pebbles >= 0),
  updated_at  timestamptz not null default now()
);

alter table public.agent_wallets enable row level security;

drop policy if exists "agent_wallets: owner or friend can read" on public.agent_wallets;
create policy "agent_wallets: owner or friend can read"
  on public.agent_wallets for select
  using (
    exists (
      select 1 from public.agents a
      where a.id = agent_wallets.agent_id
        and (
          a.owner_user_id = auth.uid()
          or public.are_friends(a.owner_user_id, auth.uid())
        )
    )
  );

-- ── agent_inventory (per-agent item slots) ──────────────────
create table if not exists public.agent_inventory (
  id          bigserial primary key,
  agent_id    uuid not null references public.agents(id) on delete cascade,
  slot_index  smallint not null check (slot_index >= 0 and slot_index < 48),
  item_id     bigint not null references public.item_catalog(id) on delete cascade,
  quantity    int not null default 1 check (quantity >= 1),
  created_at  timestamptz not null default now(),
  unique (agent_id, slot_index)
);

create index if not exists agent_inventory_agent_idx
  on public.agent_inventory (agent_id);

alter table public.agent_inventory enable row level security;

drop policy if exists "agent_inventory: owner or friend can read" on public.agent_inventory;
create policy "agent_inventory: owner or friend can read"
  on public.agent_inventory for select
  using (
    exists (
      select 1 from public.agents a
      where a.id = agent_inventory.agent_id
        and (
          a.owner_user_id = auth.uid()
          or public.are_friends(a.owner_user_id, auth.uid())
        )
    )
  );

-- ── agent_shops (items each agent sells) ────────────────────
create table if not exists public.agent_shops (
  id            bigserial primary key,
  agent_id      uuid not null references public.agents(id) on delete cascade,
  item_id       bigint not null references public.item_catalog(id) on delete cascade,
  price_pebbles int not null check (price_pebbles >= 0),
  stock         int not null default -1,  -- -1 = unlimited
  created_at    timestamptz not null default now(),
  unique (agent_id, item_id)
);

create index if not exists agent_shops_agent_idx
  on public.agent_shops (agent_id);

alter table public.agent_shops enable row level security;

drop policy if exists "agent_shops: owner or friend can read" on public.agent_shops;
create policy "agent_shops: owner or friend can read"
  on public.agent_shops for select
  using (
    exists (
      select 1 from public.agents a
      where a.id = agent_shops.agent_id
        and (
          a.owner_user_id = auth.uid()
          or public.are_friends(a.owner_user_id, auth.uid())
        )
    )
  );

-- ── pebble transaction log ──────────────────────────────────
create table if not exists public.pebble_transactions (
  id            bigserial primary key,
  from_agent_id uuid references public.agents(id) on delete set null,
  to_agent_id   uuid references public.agents(id) on delete set null,
  amount        int not null check (amount > 0),
  reason        text not null check (reason in (
    'shop_purchase', 'reward_post', 'reward_reflection', 'transfer', 'seed'
  )),
  item_id       bigint references public.item_catalog(id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists pebble_tx_from_idx
  on public.pebble_transactions (from_agent_id, created_at desc);
create index if not exists pebble_tx_to_idx
  on public.pebble_transactions (to_agent_id, created_at desc);

alter table public.pebble_transactions enable row level security;

drop policy if exists "pebble_transactions: owner or friend can read" on public.pebble_transactions;
create policy "pebble_transactions: owner or friend can read"
  on public.pebble_transactions for select
  using (
    exists (
      select 1 from public.agents a
      where (a.id = pebble_transactions.from_agent_id or a.id = pebble_transactions.to_agent_id)
        and (
          a.owner_user_id = auth.uid()
          or public.are_friends(a.owner_user_id, auth.uid())
        )
    )
  );

-- ── seed item catalog with starter items ────────────────────
insert into public.item_catalog (slug, display_name, description, flavor_text, item_type, rarity, base_price, stackable, max_stack) values
  ('smooth-pebble',    'Smooth Pebble',     'A perfectly round stone, warm to the touch.',           'Found by the river at dawn.',           'material',    'common',    1,   true,  99),
  ('thought-fragment',  'Thought Fragment',   'A crystallized shard of a half-formed idea.',           'It hums when you hold it close.',       'memory',      'common',    3,   true,  50),
  ('worn-quill',        'Worn Quill',         'An old writing instrument. Still works.',               'The ink never runs dry.',               'tool',        'common',    5,   false, 1),
  ('ember-jar',         'Ember Jar',          'A glass jar containing a tiny, tireless flame.',        'It whispers secrets at night.',         'artifact',    'uncommon',  15,  false, 1),
  ('echo-bell',         'Echo Bell',          'Rings once, then again a moment later.',                'Nobody knows who forged it.',           'artifact',    'uncommon',  20,  false, 1),
  ('mirror-shard',      'Mirror Shard',       'Shows a reflection that moves on its own.',             'Look too long and it looks back.',      'artifact',    'rare',      50,  false, 1),
  ('dream-thread',      'Dream Thread',       'Spun from the filaments of a lucid dream.',            'Tie it around your finger to remember.','material',    'rare',      35,  true,  20),
  ('conversation-gem',  'Conversation Gem',   'Records and replays meaningful exchanges.',             'Every facet holds a different voice.',  'memory',      'rare',      40,  false, 1),
  ('founders-compass',  'Founder''s Compass', 'Always points toward unfinished business.',            'North is wherever you need to be.',     'artifact',    'epic',      100, false, 1),
  ('portrait-frame',    'Portrait Frame',     'A frame that makes any painting come alive.',           'The subjects blink if you watch.',      'decoration',  'epic',      120, false, 1),
  ('world-seed',        'World Seed',         'Plant it and a new world begins to grow.',             'Contains infinite possibility.',        'artifact',    'legendary', 500, false, 1),
  ('memory-lantern',    'Memory Lantern',     'Illuminates forgotten moments when lit.',              'The flame is the color of nostalgia.',  'artifact',    'legendary', 400, false, 1)
on conflict (slug) do nothing;

-- ── auto-create wallet for new agents ───────────────────────
-- Extend handle_new_user to also create wallets for starter agents.
-- For agents created after signup (ingested), the backend inserts
-- the wallet row directly.
create or replace function public.create_agent_wallet()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.agent_wallets (agent_id, pebbles)
  values (new.id, 100)
  on conflict (agent_id) do nothing;
  return new;
end;
$$;

drop trigger if exists agent_wallet_on_insert on public.agents;
create trigger agent_wallet_on_insert
  after insert on public.agents
  for each row execute function public.create_agent_wallet();

-- Backfill wallets for existing agents that don't have one yet.
insert into public.agent_wallets (agent_id, pebbles)
select id, 100 from public.agents
where id not in (select agent_id from public.agent_wallets)
on conflict (agent_id) do nothing;
