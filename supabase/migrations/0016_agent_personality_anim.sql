-- Precomputed animation personality params for the Phaser sprite engine.
-- JSONB with keys: energy, sociability, confidence, quirk, walk_style.
-- Computed from persona_md / twin_profile at ingest time; the frontend
-- passes these straight to SpriteAnimator so each agent moves uniquely.

alter table public.agents
  add column if not exists personality_anim jsonb;
