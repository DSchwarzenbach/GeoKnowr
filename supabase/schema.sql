-- GeoGuessr Clone Schema
-- Run this in your Supabase SQL editor.

-- ============================================================
-- GAMES TABLE
-- One row per active game session.
-- ============================================================
create table if not exists games (
  id          uuid primary key default gen_random_uuid(),
  room_code   text not null unique,          -- Short human-readable code (e.g. "XK4T")
  host_name   text not null,
  status      text not null default 'lobby', -- lobby | playing | finished
  locations   jsonb not null,                -- Array of 5 {lat, lng} objects (the "seed")
  settings    jsonb not null default '{
    "round_count": 5,
    "round_time_seconds": 60,
    "max_players": 3
  }',
  current_round int not null default 1,
  created_at  timestamptz default now()
);

-- ============================================================
-- PLAYERS TABLE
-- One row per player in a game.
-- ============================================================
create table if not exists players (
  id          uuid primary key default gen_random_uuid(),
  game_id     uuid not null references games(id) on delete cascade,
  name        text not null,
  is_ready    boolean not null default false,
  total_score int not null default 0,
  created_at  timestamptz default now()
);

-- ============================================================
-- GUESSES TABLE
-- One row per player per round.
-- ============================================================
create table if not exists guesses (
  id           uuid primary key default gen_random_uuid(),
  game_id      uuid not null references games(id) on delete cascade,
  player_id    uuid not null references players(id) on delete cascade,
  round_number int not null,
  guessed_lat  float8 not null,
  guessed_lng  float8 not null,
  distance_km  float8 not null,
  round_score  int not null,
  submitted_at timestamptz default now(),

  unique(game_id, player_id, round_number)
);

-- ============================================================
-- Enable Realtime on tables that need live sync
-- ============================================================
alter publication supabase_realtime add table games;
alter publication supabase_realtime add table players;
alter publication supabase_realtime add table guesses;

-- ============================================================
-- Row Level Security (RLS) — open for this use case
-- Players only need the anon key; no auth required.
-- ============================================================
alter table games   enable row level security;
alter table players enable row level security;
alter table guesses enable row level security;

create policy "Allow all on games"   on games   for all using (true) with check (true);
create policy "Allow all on players" on players for all using (true) with check (true);
create policy "Allow all on guesses" on guesses for all using (true) with check (true);
