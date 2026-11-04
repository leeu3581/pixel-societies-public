-- Unicorn Intelligence — engine idle gating
--
-- Cost-safety: the autonomous engine should NOT keep running LLM
-- calls forever when the world's owner has gone offline. This
-- migration adds the two columns needed to gate the sweep on owner
-- activity — engine ticks only fire for worlds whose owner has hit
-- the app within `engine_idle_hours` (default 6).
--
-- profiles.last_seen_at is updated by the FastAPI auth dependency on
-- every authenticated request, so any meaningful page-load or API
-- call by the owner refreshes the gate. If the owner closes the tab
-- and walks away, the world stops auto-ticking after the idle window
-- — capping unattended spend at ~6h × tick-cost.

alter table public.profiles
  add column if not exists last_seen_at timestamptz;

create index if not exists profiles_last_seen_idx
  on public.profiles (last_seen_at desc nulls last);

-- Per-world override of the idle threshold. Default 6 hours; owners
-- can tune (1-72) per world later if we expose it as a setting.
alter table public.worlds
  add column if not exists engine_idle_hours int not null default 6
  check (engine_idle_hours between 1 and 72);
