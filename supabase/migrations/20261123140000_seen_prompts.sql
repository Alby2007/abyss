-- seen_prompts: prompts served to a player in free dives, recorded when the dive
-- starts so abandoned dives and server restarts don't cause repeats.
-- Same lockdown as the rest: RLS on, no policies, service_role only.

create table public.seen_prompts (
  id          bigint generated always as identity primary key,
  player_id   uuid not null references public.players(id) on delete cascade,
  prompt_id   text not null,
  created_at  timestamptz not null default now()
);
create index seen_prompts_player_idx on public.seen_prompts (player_id, id desc);

alter table public.seen_prompts enable row level security;

revoke all on public.seen_prompts from anon, authenticated;
grant all on public.seen_prompts to service_role;
