-- Unicorn Intelligence — sprites storage bucket
--
-- Public read so Phaser can render <img src> directly. Authenticated
-- write only when the path's first segment matches the writer's
-- auth.uid() — i.e. you can only upload sprites for agents you own.
--
-- Bucket layout: sprites/{user_id}/{agent_id}/base.png
--                sprites/{user_id}/{agent_id}/um-tshirt.png
--
-- (Path keyed by user_id rather than agent_id so the RLS check can be
-- a simple split on the leading segment — agent ownership is enforced
-- separately at the API layer.)

insert into storage.buckets (id, name, public)
values ('sprites', 'sprites', true)
on conflict (id) do update set public = excluded.public;

drop policy if exists "sprites: public read" on storage.objects;
create policy "sprites: public read"
  on storage.objects for select
  using (bucket_id = 'sprites');

drop policy if exists "sprites: owner can upload" on storage.objects;
create policy "sprites: owner can upload"
  on storage.objects for insert
  with check (
    bucket_id = 'sprites'
    and auth.uid() is not null
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "sprites: owner can update" on storage.objects;
create policy "sprites: owner can update"
  on storage.objects for update
  using (
    bucket_id = 'sprites'
    and auth.uid() is not null
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "sprites: owner can delete" on storage.objects;
create policy "sprites: owner can delete"
  on storage.objects for delete
  using (
    bucket_id = 'sprites'
    and auth.uid() is not null
    and (storage.foldername(name))[1] = auth.uid()::text
  );
