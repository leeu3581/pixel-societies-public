-- Unicorn Intelligence — worlds, canonical agents, agents
--
-- Each user gets a "home" world on signup (FarmVille plot). Agents live in
-- a world and are owned by the world's owner. canonical_agents is a
-- read-only template table seeded once from backend/data/wikis/. The
-- handle_new_user trigger clones a handful of starters into each new
-- user's home world.

-- Stub of are_friends() so the RLS policies below validate at policy
-- creation time. 0003_friendships.sql replaces this with the real body
-- once the friendships table exists. Until then it returns false, which
-- correctly means "no friend access yet" anyway.
create or replace function public.are_friends(a uuid, b uuid)
returns boolean
language sql
stable
as $$ select false $$;

-- ── worlds ───────────────────────────────────────────────────
create table if not exists public.worlds (
  id              uuid primary key default gen_random_uuid(),
  owner_user_id   uuid not null references auth.users(id) on delete cascade,
  slug            text not null,
  display_name    text,
  tile_w          smallint not null default 32,
  tile_h          smallint not null default 24,
  bg_palette      smallint not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (owner_user_id, slug)
);

create index if not exists worlds_owner_idx on public.worlds (owner_user_id);

alter table public.worlds enable row level security;

drop policy if exists "worlds: owner or friend can read" on public.worlds;
create policy "worlds: owner or friend can read"
  on public.worlds for select
  using (
    owner_user_id = auth.uid()
    or public.are_friends(owner_user_id, auth.uid())
  );

drop policy if exists "worlds: owner can insert" on public.worlds;
create policy "worlds: owner can insert"
  on public.worlds for insert
  with check (owner_user_id = auth.uid());

drop policy if exists "worlds: owner can update" on public.worlds;
create policy "worlds: owner can update"
  on public.worlds for update
  using (owner_user_id = auth.uid());

drop policy if exists "worlds: owner can delete" on public.worlds;
create policy "worlds: owner can delete"
  on public.worlds for delete
  using (owner_user_id = auth.uid());

drop trigger if exists worlds_touch_updated_at on public.worlds;
create trigger worlds_touch_updated_at
  before update on public.worlds
  for each row execute function public.touch_profile_updated_at();

-- ── canonical_agents (read-only template table) ─────────────
create table if not exists public.canonical_agents (
  id                  text primary key,
  display_name        text not null,
  subtitle            text,
  persona_md          text not null,
  default_sprite_url  text,
  default_tint        text,
  created_at          timestamptz not null default now()
);

alter table public.canonical_agents enable row level security;

drop policy if exists "canonical_agents are public" on public.canonical_agents;
create policy "canonical_agents are public"
  on public.canonical_agents for select
  using (true);
-- No insert/update/delete policies for `authenticated` role: only the
-- service role (used by seed_canonical.py) and migrations can write here.

-- ── agents (per-user world inhabitants) ─────────────────────
create table if not exists public.agents (
  id              uuid primary key default gen_random_uuid(),
  world_id        uuid not null references public.worlds(id) on delete cascade,
  owner_user_id   uuid not null references auth.users(id) on delete cascade,
  canonical_id    text references public.canonical_agents(id) on delete set null,
  display_name    text not null,
  subtitle        text,
  persona_md      text,
  sprite_url      text,
  tile_x          int not null default 0,
  tile_y          int not null default 0,
  facing          smallint not null default 0,
  tint            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists agents_world_idx        on public.agents (world_id);
create index if not exists agents_owner_idx        on public.agents (owner_user_id);
create index if not exists agents_canonical_idx    on public.agents (canonical_id);

alter table public.agents enable row level security;

drop policy if exists "agents: owner or friend can read" on public.agents;
create policy "agents: owner or friend can read"
  on public.agents for select
  using (
    owner_user_id = auth.uid()
    or public.are_friends(owner_user_id, auth.uid())
  );

drop policy if exists "agents: owner can insert" on public.agents;
create policy "agents: owner can insert"
  on public.agents for insert
  with check (owner_user_id = auth.uid());

drop policy if exists "agents: owner can update" on public.agents;
create policy "agents: owner can update"
  on public.agents for update
  using (owner_user_id = auth.uid());

drop policy if exists "agents: owner can delete" on public.agents;
create policy "agents: owner can delete"
  on public.agents for delete
  using (owner_user_id = auth.uid());

drop trigger if exists agents_touch_updated_at on public.agents;
create trigger agents_touch_updated_at
  before update on public.agents
  for each row execute function public.touch_profile_updated_at();

-- ── extend handle_new_user trigger ──────────────────────────
-- After the profile row is created, give the user a home world and clone
-- starter agents from canonical_agents at varied tile positions. If the
-- canonical_agents table is empty (first boot before seed), the world is
-- still created but with no agents — Phaser just shows an empty plot.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_world_id uuid;
  starter_slugs text[] := array['support', 'engineering', 'marketing', 'product'];
  starter_positions int[][] := array[
    array[8, 6],
    array[16, 10],
    array[24, 8],
    array[20, 16]
  ];
  i int;
  ca record;
begin
  -- Profile (existing behaviour).
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;

  -- Home world.
  insert into public.worlds (owner_user_id, slug, display_name)
  values (new.id, 'home', 'Home')
  returning id into new_world_id;

  -- Starter agents (only if their canonical templates are present).
  for i in 1..array_length(starter_slugs, 1) loop
    select * into ca from public.canonical_agents where id = starter_slugs[i];
    if found then
      insert into public.agents (
        world_id, owner_user_id, canonical_id,
        display_name, subtitle, persona_md, sprite_url, tint,
        tile_x, tile_y
      ) values (
        new_world_id, new.id, ca.id,
        ca.display_name, ca.subtitle, ca.persona_md, ca.default_sprite_url, ca.default_tint,
        starter_positions[i][1], starter_positions[i][2]
      );
    end if;
  end loop;

  return new;
end;
$$;
