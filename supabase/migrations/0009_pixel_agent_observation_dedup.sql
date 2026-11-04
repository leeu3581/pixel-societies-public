-- Unicorn Intelligence — observation-memory dedup
--
-- Each tick, every agent perceives a set of peer posts (the rows in
-- ctx.recent_world_posts) and writes a 'kind=observation' memory row
-- for each one. We don't want the same agent storing duplicate
-- observation rows for the same source post across consecutive ticks
-- — that would inflate the importance sum without adding signal.
--
-- A partial unique index gives us atomic dedup via Postgres' native
-- INSERT ... ON CONFLICT DO NOTHING. Sparse — applies only to
-- observation rows; post and reflection rows are unaffected.

create unique index if not exists pixel_agent_memories_observation_unique
  on public.pixel_agent_memories (agent_id, source_post_id)
  where kind = 'observation';
