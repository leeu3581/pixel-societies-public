-- Twin profile: stores structured data extracted from the voice onboarding
-- interview (Gemini Live API). Keyed fields: name, role, current_work,
-- looking_for, unique_knowledge, social_style.
alter table public.profiles
  add column if not exists twin_profile jsonb;

comment on column public.profiles.twin_profile is
  'Structured twin profile extracted from voice onboarding interview';
