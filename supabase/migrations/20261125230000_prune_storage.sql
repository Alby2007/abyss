-- Housekeeping: one function the server calls occasionally to keep tables bounded.
-- rejected_guesses keeps only the newest 5000 rows (the admin view reads 5000 anyway),
-- expired sessions are removed, and dive-less guests inactive for 30 days are reaped.
-- Guests with dives stay: their leaderboard history is part of the game.
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
$$;

revoke all on function public.prune_storage() from public, anon, authenticated;
