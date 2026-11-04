-- Pixel Societies — per-user Auto toggle for group room chatter
--
-- When a member flips "Auto" off in the room UI, they're saying
-- "quiet down — let me read / chat manually". The autonomous loop
-- skips the group while ALL active members have auto disabled.
-- Default true so newly joined groups behave like before.

alter table public.world_group_members
  add column if not exists auto_enabled boolean not null default true;

-- Realtime subscribers (the room UI) need to see updates so the
-- toggle reflects across tabs. Already in publication via 0018; no
-- change needed here.
