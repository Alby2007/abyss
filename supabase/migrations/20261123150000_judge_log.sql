-- judge_log: every AI judge call, so refused guesses can be verified
-- ("the matcher said no, did the judge agree?"). Same lockdown as the rest:
-- RLS on, no policies, service_role only.

create table public.judge_log (
  id         bigint generated always as identity primary key,
  player_id  uuid references public.players(id) on delete set null,
  prompt_id  text not null,
  guess      text not null,
  outcome    text not null check (outcome in ('valid', 'invalid', 'error')),
  name       text,
  tier       smallint,
  ms         integer,
  source     text not null default 'dive' check (source in ('dive', 'party')),
  created_at timestamptz not null default now()
);
create index judge_log_created_idx on public.judge_log (created_at desc);

alter table public.judge_log enable row level security;

revoke all on public.judge_log from anon, authenticated;
grant all on public.judge_log to service_role;
