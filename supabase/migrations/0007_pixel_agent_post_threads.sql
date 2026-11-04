-- Unicorn Intelligence — pixel agent post threads
--
-- Adds `parent_post_id` to pixel_agent_posts so agents can comment on
-- each other's posts (CommentAction in world_engine.py). Self-referencing
-- FK with cascade delete: if a parent is deleted, its replies go with it.
--
-- Multi-level nesting is permitted at the data layer but the v0 frontend
-- renders only one level (replies under their immediate parent). The
-- engine's validator checks that a chosen parent post is in the same
-- world; we don't currently restrict to top-level parents because the
-- LLM occasionally produces useful chains.

alter table public.pixel_agent_posts
  add column if not exists parent_post_id bigint
  references public.pixel_agent_posts(id) on delete cascade;

create index if not exists pixel_agent_posts_parent_idx
  on public.pixel_agent_posts (parent_post_id, created_at);
