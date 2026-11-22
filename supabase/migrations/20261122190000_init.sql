-- abyss: players, sessions, dives and answer stats.
-- Only the game server talks to these tables, using the service_role key.
-- RLS is on with no policies, and anon/authenticated have no grants, so the
-- public Data API exposes nothing even if someone finds the project URL.

create extension if not exists citext with schema extensions;

create table public.players (
  id             uuid primary key default gen_random_uuid(),
  username       extensions.citext unique,           -- null for guests
  display_name   text not null,
  password_hash  text,                               -- scrypt, null for guests
  is_guest       boolean not null default false,
  created_at     timestamptz not null default now(),
  last_seen_at   timestamptz,
  constraint accounts_have_login check (is_guest or (username is not null and password_hash is not null)),
  constraint username_shape check (username is null or username ~ '^[A-Za-z0-9_]{3,20}$')
);

create table public.sessions (
  token_hash  text primary key,                      -- sha256 of the cookie token
  player_id   uuid not null references public.players(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index sessions_player_idx on public.sessions (player_id);

create table public.dives (
  id          bigint generated always as identity primary key,
  player_id   uuid not null references public.players(id) on delete cascade,
  mode        text not null check (mode in ('daily', 'unlimited')),
  dive_date   date not null,
  score       integer not null check (score >= 0),
  picks       jsonb not null,
  created_at  timestamptz not null default now()
);
create unique index dives_one_daily_per_player on public.dives (player_id, dive_date) where mode = 'daily';
create index dives_daily_date_idx on public.dives (dive_date) where mode = 'daily';
create index dives_player_idx on public.dives (player_id, dive_date desc);

create table public.answer_counts (
  prompt_id  text not null,
  answer     text not null,
  n          integer not null default 0,
  primary key (prompt_id, answer)
);

create table public.rejected_guesses (
  id          bigint generated always as identity primary key,
  prompt_id   text not null,
  guess       text not null,
  player_id   uuid references public.players(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index rejected_prompt_idx on public.rejected_guesses (prompt_id);

create table public.accepted_answers (
  prompt_id   text not null,
  name        text not null,
  tier        integer not null check (tier between 1 and 5),
  created_at  timestamptz not null default now(),
  primary key (prompt_id, name)
);

-- atomic +1 for "how many people said this"
create or replace function public.bump_answer(p_prompt text, p_answer text)
returns integer
language sql
set search_path = public
as $$
  insert into public.answer_counts as a (prompt_id, answer, n)
  values (p_prompt, p_answer, 1)
  on conflict (prompt_id, answer) do update set n = a.n + 1
  returning n;
$$;

-- all-time table across daily dives
create or replace function public.all_time_board(p_limit integer default 100)
returns table (display_name text, is_guest boolean, total bigint, dives bigint, best integer)
language sql
stable
set search_path = public
as $$
  select p.display_name, p.is_guest, sum(d.score), count(*), max(d.score)
  from public.dives d join public.players p on p.id = d.player_id
  where d.mode = 'daily'
  group by p.id, p.display_name, p.is_guest
  order by sum(d.score) desc
  limit p_limit;
$$;

-- lock everything down to the server
alter table public.players          enable row level security;
alter table public.sessions         enable row level security;
alter table public.dives            enable row level security;
alter table public.answer_counts    enable row level security;
alter table public.rejected_guesses enable row level security;
alter table public.accepted_answers enable row level security;

revoke all on public.players, public.sessions, public.dives, public.answer_counts,
              public.rejected_guesses, public.accepted_answers from anon, authenticated;
grant all on public.players, public.sessions, public.dives, public.answer_counts,
             public.rejected_guesses, public.accepted_answers to service_role;
grant usage, select on all sequences in schema public to service_role;

revoke execute on function public.bump_answer(text, text) from public, anon, authenticated;
revoke execute on function public.all_time_board(integer) from public, anon, authenticated;
grant execute on function public.bump_answer(text, text) to service_role;
grant execute on function public.all_time_board(integer) to service_role;
