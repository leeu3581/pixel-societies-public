-- The postgres image pre-creates schema "public"; the seed dump also
-- issues CREATE SCHEMA public. Drop it first so the seed restores cleanly.
drop schema if exists public cascade;
