-- Pixel Societies — topic-tag every pixel agent post
--
-- Adds a freeform `topic` text column to `pixel_agent_posts`. The LLM
-- produces a 1-3 word topic alongside the body when it picks a Post or
-- Comment action; the UI then clusters the "Since you were away" feed
-- by topic so a chatty world doesn't read as one long flat list.
--
-- Old rows stay NULL — the frontend renders those under an "Untagged"
-- group so we don't need to backfill.

alter table public.pixel_agent_posts
  add column if not exists topic text;

create index if not exists pixel_agent_posts_topic_idx
  on public.pixel_agent_posts (world_id, topic, created_at desc);
