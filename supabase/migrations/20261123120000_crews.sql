-- crews: private leaderboards friends join with an invite code.
-- Same lockdown as the rest: RLS on, no policies, service_role only.

create table public.crews (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique check (code ~ '^[A-Z]{5}$'),
  name        text not null check (char_length(name) between 1 and 30),
  owner_id    uuid not null references public.players(id) on delete cascade,
  created_at  timestamptz not null default now()
);
create index crews_owner_idx on public.crews (owner_id);

create table public.crew_members (
  crew_id    uuid not null references public.crews(id) on delete cascade,
  player_id  uuid not null references public.players(id) on delete cascade,
  joined_at  timestamptz not null default now(),
  primary key (crew_id, player_id)
);
create index crew_members_player_idx on public.crew_members (player_id);

alter table public.crews         enable row level security;
alter table public.crew_members  enable row level security;

revoke all on public.crews, public.crew_members from anon, authenticated;
grant all on public.crews, public.crew_members to service_role;
