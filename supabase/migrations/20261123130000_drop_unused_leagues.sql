-- 20261122200000_leagues.sql was committed by mistake; crews (20261123120000) are the
-- private leaderboards the game actually uses. Remove the unused tables. The old file
-- stays in place so environments that already ran it keep a matching history.
drop table if exists public.league_members;
drop table if exists public.leagues;
