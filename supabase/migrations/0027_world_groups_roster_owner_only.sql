-- Curated rooms (e.g. event demo worlds) should show ONLY the room
-- creator's agents, so that other users who join the room never drag
-- their own agents into the roster or the room conversation.
--
-- Default false preserves the existing "pool all accepted members'
-- agents" behaviour for the public square and normal social rooms.
alter table public.world_groups
  add column if not exists roster_owner_only boolean not null default false;
