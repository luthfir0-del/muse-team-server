-- muse-team-server — tabel state di Supabase.
-- Cara pakai: di dashboard Supabase → SQL Editor → tempel seluruh isi
-- file ini → Run. Sekali saja; server mengisi barisnya sendiri saat
-- pertama jalan (dari data/seed.json).
--
-- Satu tabel, satu baris (id = 1) berisi seluruh state tim sebagai JSON.
-- Kunci service_role (yang dipakai server) melewati Row Level Security,
-- jadi tidak perlu policy tambahan untuk server ini. Jangan pernah
-- membagikan service_role key ke browser atau ke agent lain selain
-- lewat env var server.

create table if not exists public.team_state (
  id integer primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);
