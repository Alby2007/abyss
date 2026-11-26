-- One-shot daily dives: a dive is committed to the database the moment it starts.
-- finished=false rows are in-progress dives: they enforce the one-go rule (the
-- unique index on (player_id, dive_date) already applies to them), they let a
-- crashed or restarted server reconstruct live sessions, and they make closing
-- the tab mid-dive pointless as a re-deal cheat — start again and you resume.
-- Existing rows are all finished, hence the default.
alter table public.dives
  add column if not exists finished boolean not null default true,
  add column if not exists prompt_ids jsonb,
  add column if not exists session_id uuid;

-- boot-time recovery scans for recent unfinished rows
create index if not exists dives_unfinished_idx on public.dives (created_at) where not finished;

-- boards must only ever count finished dives
create or replace function public.all_time_board(p_limit integer default 100)
returns table (display_name text, is_guest boolean, total bigint, dives bigint, best integer)
language sql
stable
set search_path = public
as $$
  select p.display_name, p.is_guest, sum(d.score), count(*), max(d.score)
  from public.dives d join public.players p on p.id = d.player_id
  where d.mode = 'daily' and d.finished
  group by p.id, p.display_name, p.is_guest
  order by sum(d.score) desc
  limit p_limit;
$$;

revoke execute on function public.all_time_board(integer) from public, anon, authenticated;
grant execute on function public.all_time_board(integer) to service_role;

-- housekeeping additionally reaps dives abandoned mid-way after 7 days. By then
-- their dive_date is long past, so deleting them can never reopen a re-deal.
create or replace function public.prune_storage() returns void
language sql security definer set search_path = public as $$
  delete from public.rejected_guesses where id not in (
    select id from public.rejected_guesses order by created_at desc limit 5000
  );
  delete from public.sessions where expires_at < now();
  delete from public.players p
    where p.is_guest
      and coalesce(p.last_seen_at, p.created_at) < now() - interval '30 days'
      and not exists (select 1 from public.dives d where d.player_id = p.id);
  delete from public.dives where not finished and created_at < now() - interval '7 days';
$$;

revoke all on function public.prune_storage() from public, anon, authenticated;
-- the original migration missed this: revoking the blanket public grant left
-- service_role unable to call the function at all, so pruning never ran
grant execute on function public.prune_storage() to service_role;
