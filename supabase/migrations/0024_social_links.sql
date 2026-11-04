-- Add social links JSONB column to profiles.
-- Stores { github, linkedin, twitter, instagram } URLs.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS social_links jsonb DEFAULT '{}';
