-- Store the real uploaded onboarding photo alongside the generated sprite.

alter table public.profiles
  add column if not exists photo_url text;
