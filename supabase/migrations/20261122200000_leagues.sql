-- Private leaderboards: a named group with a join code. Members see each other's daily dives.

create table public.leagues (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique check (code ~ '^[A-Z2-9]{6}$'),
  name        text not null check (char_length(name) between 1 and 30),
  owner_id    uuid not null references public.players(id) on delete cascade,
  created_at  timestamptz not null default now()
);

create table public.league_members (
  league_id   uuid not null references public.leagues(id) on delete cascade,
  player_id   uuid not null references public.players(id) on delete cascade,
  joined_at   timestamptz not null default now(),
  primary key (league_id, player_id)
);
create index league_members_player_idx on public.league_members (player_id);

alter table public.leagues        enable row level security;
alter table public.league_members enable row level security;
revoke all on public.leagues, public.league_members from anon, authenticated;
grant all on public.leagues, public.league_members to service_role;
