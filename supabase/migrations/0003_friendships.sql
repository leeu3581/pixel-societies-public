-- Unicorn Intelligence — friendships
--
-- Bidirectional accept. Either side may send a request; only the
-- addressee can flip status to 'accepted'. v0 has no 'blocked' state —
-- add later when block flows are designed.
--
-- public.are_friends(a, b) is the helper used by RLS on worlds, agents
-- and (later) messages. 0002 defined a stub returning false; we replace
-- it here with the real body now that the friendships table exists.

create table if not exists public.friendships (
  id              uuid primary key default gen_random_uuid(),
  requester_id    uuid not null references auth.users(id) on delete cascade,
  addressee_id    uuid not null references auth.users(id) on delete cascade,
  status          text not null default 'pending'
                  check (status in ('pending', 'accepted')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (requester_id <> addressee_id)
);

-- Prevent duplicate pairs regardless of which side sent the request.
create unique index if not exists friendships_unique_pair
  on public.friendships (
    least(requester_id, addressee_id),
    greatest(requester_id, addressee_id)
  );

create index if not exists friendships_requester_idx on public.friendships (requester_id);
create index if not exists friendships_addressee_idx on public.friendships (addressee_id);
create index if not exists friendships_status_idx    on public.friendships (status);

alter table public.friendships enable row level security;

drop policy if exists "friendships: participants can read" on public.friendships;
create policy "friendships: participants can read"
  on public.friendships for select
  using (auth.uid() = requester_id or auth.uid() = addressee_id);

drop policy if exists "friendships: anyone can request" on public.friendships;
create policy "friendships: anyone can request"
  on public.friendships for insert
  with check (
    auth.uid() = requester_id
    and auth.uid() <> addressee_id
  );

-- Only the addressee can change status (accept / future decline).
-- Requester can delete their own pending request (cancel) — handled
-- via delete policy below.
drop policy if exists "friendships: addressee can update" on public.friendships;
create policy "friendships: addressee can update"
  on public.friendships for update
  using (auth.uid() = addressee_id);

drop policy if exists "friendships: requester or addressee can delete" on public.friendships;
create policy "friendships: requester or addressee can delete"
  on public.friendships for delete
  using (auth.uid() = requester_id or auth.uid() = addressee_id);

drop trigger if exists friendships_touch_updated_at on public.friendships;
create trigger friendships_touch_updated_at
  before update on public.friendships
  for each row execute function public.touch_profile_updated_at();

-- Real are_friends body. Replaces the stub from 0002.
create or replace function public.are_friends(a uuid, b uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.friendships f
    where f.status = 'accepted'
      and (
        (f.requester_id = a and f.addressee_id = b)
        or
        (f.requester_id = b and f.addressee_id = a)
      )
  )
$$;
