-- Unicorn Intelligence — autonomous engine flags on worlds
--
-- Adds two columns to public.worlds:
--   engine_enabled        — opt-in flag, default false; owners flip it
--                           on for their world to let the engine tick
--                           autonomously in the background.
--   engine_last_tick_at   — last successful tick timestamp; used by the
--                           engine sweep to decide whether the tick
--                           interval has elapsed.
--
-- The interval itself is currently a constant in app/world_engine.py
-- (ENGINE_TICK_INTERVAL_MINUTES). When per-world rates become a real
-- product surface we'll add an `engine_tick_interval_minutes` column.

alter table public.worlds
  add column if not exists engine_enabled boolean not null default false;

alter table public.worlds
  add column if not exists engine_last_tick_at timestamptz;

create index if not exists worlds_engine_enabled_idx
  on public.worlds (engine_enabled, engine_last_tick_at)
  where engine_enabled = true;
