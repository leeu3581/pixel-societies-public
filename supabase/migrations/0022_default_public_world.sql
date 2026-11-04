-- Pixel Societies — default public World everyone is auto-joined to
--
-- One known-slug world_group (`pixel-square`) acts as the global lobby.
-- Every existing user gets an accepted membership at migration time;
-- a trigger on profiles ensures new signups are auto-joined too.
--
-- The /worlds (Public) page surfaces a CTA into this group, so the
-- click-to-enter flow is one tap.

-- ── Create the default group ────────────────────────────────────────
-- Picked the first profile as the formal `created_by` so the
-- foreign key is satisfied. If no profiles exist yet (fresh install),
-- this is a no-op; the group will be auto-created on the first signup
-- via the trigger below.
do $$
declare
  bootstrap_owner uuid;
  square_id uuid;
begin
  select id into bootstrap_owner
    from public.profiles
   order by created_at asc nulls last
   limit 1;

  if bootstrap_owner is not null then
    insert into public.world_groups
      (name, slug, description, visibility, created_by)
    values (
      'Pixel Globe',
      'pixel-square',
      'The default public world — every Pixel Societies user is here. Hang out, chat, watch the room.',
      'public',
      bootstrap_owner
    )
    on conflict (slug) do nothing
    returning id into square_id;

    if square_id is null then
      select id into square_id from public.world_groups where slug = 'pixel-square';
    end if;

    -- Backfill: every existing user becomes an accepted member.
    insert into public.world_group_members (group_id, user_id, status, joined_at, invited_at)
    select square_id, p.id, 'accepted', now(), now()
      from public.profiles p
     on conflict (group_id, user_id) do update
        set status = 'accepted',
            joined_at = coalesce(public.world_group_members.joined_at, now());
  end if;
end $$;

-- ── Trigger: auto-join new signups ──────────────────────────────────
create or replace function public.auto_join_pixel_square()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  square_id uuid;
begin
  select id into square_id from public.world_groups where slug = 'pixel-square';

  -- If the default group doesn't exist yet (fresh install, no prior
  -- profiles), bootstrap it now using this new profile as creator.
  if square_id is null then
    insert into public.world_groups
      (name, slug, description, visibility, created_by)
    values (
      'Pixel Globe',
      'pixel-square',
      'The default public world — every Pixel Societies user is here. Hang out, chat, watch the room.',
      'public',
      new.id
    )
    on conflict (slug) do nothing
    returning id into square_id;
    if square_id is null then
      select id into square_id from public.world_groups where slug = 'pixel-square';
    end if;
  end if;

  if square_id is not null then
    insert into public.world_group_members
      (group_id, user_id, status, joined_at, invited_at)
    values (square_id, new.id, 'accepted', now(), now())
    on conflict (group_id, user_id) do nothing;
  end if;

  return new;
end;
$$;

drop trigger if exists profiles_auto_join_pixel_square on public.profiles;
create trigger profiles_auto_join_pixel_square
  after insert on public.profiles
  for each row execute function public.auto_join_pixel_square();
