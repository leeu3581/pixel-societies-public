-- Rename the default public world's display name to "Pixel Globe".
-- Slug stays `pixel-square` so existing /worlds/pixel-square links and
-- bookmarks keep working — only the human-readable label changes.

update public.world_groups
   set name = 'Pixel Globe'
 where slug = 'pixel-square';
