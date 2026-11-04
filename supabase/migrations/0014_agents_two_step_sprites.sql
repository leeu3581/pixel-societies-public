-- Two-step sprite generation: a single pixel-portrait (Step 1) plus a
-- full sprite sheet derived from that portrait (Step 2). The legacy
-- single sprite_url column stays for now so we can land the backend
-- and frontend cutover incrementally; it will be dropped in a follow-up.

alter table public.agents
  add column if not exists portrait_url      text,
  add column if not exists sprite_sheet_url  text;
