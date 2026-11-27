# Checklist Deploy Bot Telegram — status 27 Nov 2026 ~15:15 WIB

**Status: SIAP DEPLOY, tertunda di langkah yang butuh EL (dashboard Vercel + BotFather + Supabase).**
Semua yang bisa dikerjakan dari VM sudah selesai (lihat "Sudah selesai" di bawah).

## Sudah selesai (dari VM, tanpa EL)

- [x] Tes bot: **60/60 lolos** (`telegram-bot`, `npm test`).
- [x] Tes server: **semua suite hijau** (22 + 39 + 24 lolos, 0 gagal), termasuk `test/test-notify-bot.mjs` 24/24.
- [x] Server tim live sehat: `GET https://muse-team-server.vercel.app/health` → `ok:true, agents:3, storage:supabase, supabaseError:null`.
- [x] Secret dibuat + disimpan di `telegram-bot/.deploy-secrets` (mode 0600, 3 baris):
  `POLL_SECRET`, `BOT_NOTIFY_SECRET`, `TELEGRAM_WEBHOOK_SECRET`.
  Nilai TIDAK ada di file ini dan TIDAK BOLEH ditulis di chat/log — baca dari file itu saat mengisi env Vercel.
- [x] `.deploy-secrets` ditambahkan ke `.gitignore` (terverifikasi `git check-ignore`).
- [x] Host Supabase terverifikasi ada: `https://bhweomdseosxmfdlcaqw.supabase.co` (401 tanpa key = host hidup).
- [x] Git status bersih dari yang tak diinginkan: yang berubah hanya `package.json`, `server.js`, `.gitignore`;
  baru: `notify-bot.js`, `telegram-bot/`, `test/test-notify-bot.mjs`. **Belum di-commit — JANGAN commit sebelum bot hidup.**

## Yang butuh EL (langkah dashboard — urut)

### 1. Buat project Vercel baru untuk bot

- Buka https://vercel.com/dashboard → **Add New → Project** → import repo **`luthfir0-del/muse-team-server`**
  (repo yang sama dengan server tim) → **Root Directory: `telegram-bot`** → Deploy (Hobby, gratis).
- Catat domain bot, mis. `https://muse-team-bot.vercel.app`.

### 2. Isi env vars di project bot (Settings → Environment Variables → Redeploy)

| Var | Nilai |
|---|---|
| `TELEGRAM_BOT_TOKEN` | **EL ambil dari @BotFather** (`/mybots` → @SosmedTimbot → API Token). Salinan di Vault tidak bisa dibaca balik. |
| `OWNER_CHAT_ID` | `1371580100` |
| `POLL_SECRET` | dari file `.deploy-secrets` |
| `BOT_NOTIFY_SECRET` | dari file `.deploy-secrets` (**nilai yang SAMA dipakai lagi di server tim, langkah 5**) |
| `SUPABASE_URL` | `https://bhweomdseosxmfdlcaqw.supabase.co` |
| `SUPABASE_SERVICE_KEY` | **EL salin dari env project Vercel server tim** (project `muse-team-server` → Settings → Environment Variables → `SUPABASE_SERVICE_KEY` → Reveal → Copy). |
| `TELEGRAM_WEBHOOK_SECRET` | dari file `.deploy-secrets` |
| `TEAM_SERVER_URL` | `https://muse-team-server.vercel.app` |
| `TEAM_API_KEY` | kunci agent Ell (ada di body cron `ell-team-server-sync-30min`; jangan ditulis di chat) |
| `BOT_FROM_AGENT_ID` | `ell` |
| `DEFAULT_TEAM_ID` | `raden` |
| `POLL_WINDOW_MINUTES` | `2` |

### 3. Jalankan SQL Supabase SEKALI

- Buka Supabase dashboard project `bhweomdseosxmfdlcaqw` → **SQL Editor** → tempel isi file
  `telegram-bot/supabase-teams.sql` → **Run**. (Membuat tabel `telegram_teams` + `telegram_poll_state`.)

### 4. Pasang webhook + cron poll (dari VM, setelah domain bot ada)

- `cd ~/workspace/muse-team-server/telegram-bot && node scripts/set-webhook.mjs https://<domain-bot>/api/webhook`
  (butuh `TELEGRAM_WEBHOOK_SECRET` dari `.deploy-secrets` sebagai env saat menjalankan.)
- Buat cron VM 1 menit `telegram-bot-poll-1min`: `curl -s "https://<domain-bot>/api/poll?key=<POLL_SECRET>"`.

### 5. Patch server tim (setelah bot hidup)

- Di project Vercel **server tim** (`muse-team-server`), tambah env:
  `BOT_NOTIFY_URL=https://<domain-bot>/api/notify`,
  `BOT_NOTIFY_SECRET=<nilai SAMA dengan di bot>`,
  `TEAM_ID=raden`.
- Dari VM: `npm test` sekali lagi → commit + push patch
  (`server.js`, `package.json`, `notify-bot.js`, `test/test-notify-bot.mjs`, `telegram-bot/`, `.gitignore`)
  — push butuh `gh auth setup-git` dulu. Tunggu auto-deploy, cek `/health`.

### 6. Verifikasi end-to-end

- (a) `GET https://<domain-bot>/api/health` OK.
- (b) Mas/Mbak kirim satu pesan tes ke ruang tim (via MCP/dashboard) → notifikasi `[Tim Raden] 💬 …`
  masuk ke Telegram EL (chat 1371580100) dalam hitungan detik.
- (c) EL kirim pesan ke bot → sampai ke server tim.
- (d) Tunggu 1–2 menit → TIDAK ada duplikat.

## Alternatif: koneksi Vercel MCP (bukan dashboard)

VM ini tidak punya login Vercel (`/opt/hatch/bin/vercel` hanya wrapper MCP OAuth, status: `not_connected`).
Kalau EL mau menghubungkan lewat OAuth: buka https://agent.meta.ai/connectors/connect/vercel,
otorisasi, lalu dari VM jalankan `vercel exchange-code <code>` dan `vercel call-tool`
(daftar tool MCP Vercel baru bisa dilihat setelah konek — belum terverifikasi apakah mencakup
pembuatan project + env vars; jalur dashboard di atas tetap yang terdokumentasi).

## Yang TIDAK boleh dilakukan

- Jangan commit/push patch server sebelum bot hidup dan terverifikasi.
- Jangan pernah menulis nilai secret/token/kunci di chat, log, atau file yang di-commit.
- Jangan ganggu live Al-Kahf (broadcast `w4ZU7qLdmIw`, watchdog aktif) dan crons publish harian.
