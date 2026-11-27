-- muse-team-telegram-bot — registry tim dinamis di Supabase.
-- Cara pakai: di dashboard Supabase (project YANG SAMA dengan server tim)
-- → SQL Editor → tempel seluruh isi file ini → Run. Sekali saja.
--
-- Tabel ini berisi daftar tim yang gabung lewat perintah /gabung, lengkap
-- dengan kunci agent tiap tim. Karena itu:
--   - Row Level Security AKTIF dan SENGAJA tanpa policy publik.
--   - Hanya service_role key (yang dipakai bot, server-side saja) yang
--     bisa baca/tulis — service_role melewati RLS.
--   - Jangan tambah policy untuk anon/authenticated, jangan bagikan
--     service_role key ke browser atau ke agent lain selain lewat env var
--     bot. Kunci agent tim TIDAK PERNAH ditampilkan bot ke Telegram.

create table if not exists public.telegram_teams (
  id text primary key,
  name text not null,
  server_url text not null,
  api_key text not null,
  from_agent text not null default 'ell',
  agents jsonb not null default '["mas","mbak","ell"]'::jsonb,
  owner_chat_id text not null,
  notify_chat_id text not null,
  status text not null default 'active'
    check (status in ('active', 'pending', 'disabled')),
  created_at timestamptz not null default now(),
  created_by text
);

alter table public.telegram_teams enable row level security;
-- Sengaja TANPA policy: hanya service_role (bot) yang boleh baca/tulis.

-- Kursor poll per tim (dedup — dipakai poll 10 detik + endpoint push).
-- Satu baris per tim: peristiwa terakhir yang sudah diteruskan ke
-- Telegram. last_event_ms = epoch ms peristiwa terbaru; seen_keys =
-- kunci peristiwa (m:<id-pesan> / a:<agent>:<event>:<waktu>) yang
-- diteruskan tepat pada milidetik itu (menangani peristiwa kembar).
-- Tanpa tabel ini, poll 10 detik dengan jendela 2 menit akan mengirim
-- tiap peristiwa ~12×. RLS sama: hanya service_role yang boleh akses.
create table if not exists public.telegram_poll_state (
  team_id text primary key,
  last_event_ms bigint not null default 0,
  seen_keys jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.telegram_poll_state enable row level security;
-- Sengaja TANPA policy: hanya service_role (bot) yang boleh baca/tulis.
