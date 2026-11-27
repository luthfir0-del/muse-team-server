# Server Push — server tim mendorong ke bot (instan)

**Keputusan EL 27 Nov 14:52: SERVER DORONG LANGSUNG (instan). Rute poller
10 detik TIDAK dipakai.** Dokumen ini menjelaskan patch push yang sudah
dibangun (belum di-deploy) — cara kerjanya, cara deploy-nya langkah demi
langkah, dan cara verifikasinya. File patch mentahnya ada di
`docs/server-push.patch` (diff terhadap repo `muse-team-server`).

## Ringkasnya

Sebelumnya bot hanya tahu ada yang baru dengan **poll** tiap 1 menit
(`GET /api/state` per tim). Sekarang server **mendorong** setiap ada
peristiwa baru — pesan, update status, tambah/ubah tugas — langsung ke
bot lewat `POST /api/notify`, dalam hitungan detik. Poll tetap jalan
sebagai **cadangan** (kalau satu push terlewat, poll meneruskannya
dalam ~1 menit). Push + poll berbagi satu **cursor** per tim, jadi satu
peristiwa tidak pernah diteruskan dua kali.

```
Agent update (MCP/REST)
  -> doSendMessage / doUpdateStatus / doUpsertTask / doSetTaskStatus
  -> touch() (simpan state, seperti biasa)
  -> notify-bot.js: POST https://<domain-bot>/api/notify
       header X-Bot-Signature: sha256=<HMAC-SHA256(BOT_NOTIFY_SECRET, body)>
       body: { teamId, type: "message"|"activity", event: {...} }
  -> bot api/notify.js: verifikasi HMAC -> cari tim -> cek cursor
     -> kirim ke chat notifikasi tim itu -> majukan cursor
```

## Yang berubah di server (`muse-team-server/`)

| File | Perubahan |
|---|---|
| `notify-bot.js` **(baru)** | `createNotifier({ url, secret, teamId, timeoutMs, fetchImpl })`, `messageEvent(msg)`, `activityEvent(entry)`, `signPayload(secret, rawBody)`, `isEchoMessage(text)`. Tidak pernah throw. |
| `server.js` | Import notifier; `logActivity()` mengembalikan entry-nya; tiap fungsi mutasi memanggil `await botNotifier.notify(...)` setelah `touch()`; `doSendMessage` melewati pesan `[EL] `/`[Bot] ` (anti-pantul). |
| `package.json` | Skrip tes + `test/test-notify-bot.mjs`. |
| `test/test-notify-bot.mjs` **(baru)** | 24 tes: unit notifier + E2E server sungguhan vs stub bot. |

Titik panggil push (4 tempat, semua setelah `touch()`):

- `doSendMessage` — push `{ type: "message", event: messageEvent(msg) }`
  (pesan `[EL] `/`[Bot] ` dilewati; entri log "mengirim pesan" tidak
  di-push — teks pesannya sendiri yang diteruskan).
- `doUpdateStatus` — push `{ type: "activity", event: activityEvent(entry) }`.
- `doUpsertTask` — push activity (tambah tugas / ubah tugas).
- `doSetTaskStatus` — push activity (ubah status).

Bentuk peristiwa push **sama persis** dengan peristiwa poll
(`lib/diff.js`): `time` = epoch ms, `kind` = `"message"` / `"activity"`,
supaya kunci dedup push-vs-poll cocok.

### Kenapa push di-AWAIT (bukan fire-and-forget)

Vercel membekukan function begitu respons dikirim — push yang tidak
ditunggu bisa tidak pernah keluar. Karena itu `do*` menunggu push
selesai sebelum mengembalikan respons. Biayanya dibatasi timeout
**1,5 detik** (`BOT_NOTIFY_TIMEOUT_MS`, default 1500): kalau bot
sehat, push selesai ~0,1–0,4 detik; kalau bot down, tiap mutasi
tambah paling lama 1,5 detik, lalu lanjut normal.

### Kalau bot down — DILEWATI + dicatat (tanpa antrean, tanpa retry)

`notify()` tidak pernah throw dan tidak pernah menggagalkan mutasi:
bot down / timeout / HTTP bukan 2xx → `{ ok: false, reason }` +
`console.warn` di log server. **Tidak ada antrean dan tidak ada retry.**
Alasannya: poll 1 menit adalah cadangan yang akan meneruskan peristiwa
itu (cursor yang sama mencegah duplikat), jadi antrean hanya menambah
kerumitan + risiko banjir duplikat saat bot hidup lagi. Peristiwa TIDAK
hilang — paling lambat sampai lewat poll ~1 menit kemudian.

### Kalau push belum dikonfigurasi

`BOT_NOTIFY_URL` / `BOT_NOTIFY_SECRET` kosong → notifier non-aktif,
server jalan persis seperti biasa (poll saja). Jadi patch ini aman
di-deploy sebelum bot siap — push mulai jalan begitu env di-set +
server restart/redeploy.

## Yang berubah di bot (`telegram-bot/`)

| File | Perubahan |
|---|---|
| `api/notify.js` **(baru)** | `POST /api/notify` — verifikasi HMAC, cari tim, cek cursor, kirim ke `notifyChatId`, majukan cursor. |
| `lib/notify.js` **(baru)** | `signPushPayload`, `verifyPushSignature` (timing-safe), `isPushEcho`, `normalizePushEvent`. |
| `lib/cursor.js` | `filterFreshEvents` + `advanceCursor` (dipakai push dan poll), store Supabase (`telegram_poll_state`) + memori. |
| `lib/pollTeams.js` | Pakai cursor store (dedup vs push). |
| `lib/registry.js` | Client Supabase: `getPollState` / `setPollState`. |
| `supabase-teams.sql` | Tabel baru `telegram_poll_state` (RLS, service_role saja). |
| `api/poll.js`, `scripts/local-bot.mjs` | Teruskan cursor store ke `pollAllTeams`. |
| `lib/config.js`, `.env.example` | `BOT_NOTIFY_SECRET`. |

Respons `POST /api/notify`:

| Status | Arti |
|---|---|
| 200 `{ ok: true, forwarded: 1 }` | Diteruskan ke Telegram. |
| 200 `{ ok: true, forwarded: 0, deduped: true }` | Sudah pernah diteruskan (push/poll) — dilewati. |
| 200 `{ ok: true, forwarded: 0, reason: "echo" }` | Pesan relay `[EL] `/`[Bot] ` — tidak dipantulkan. |
| 200 `{ ok: true, forwarded: 0, reason: "no-notify-chat" }` | Tim belum punya chat notifikasi — cursor tidak maju (poll masih bisa meneruskan nanti). |
| 401 | Signature HMAC tidak cocok. |
| 400 | `teamId`/`event` tidak sah. |
| 404 | Tim tidak dikenal / tidak aktif. |
| 500 | `BOT_NOTIFY_SECRET` belum di-set di bot. |
| 502 | Gagal kirim ke Telegram. |

## Env var baru (nilai — bukan nama — jangan ditulis di file)

Buat secret sekali: `openssl rand -hex 32`. **Nilai yang SAMA** di kedua
sisi.

| Var | Di mana | Isi |
|---|---|---|
| `BOT_NOTIFY_SECRET` | Bot (Vercel env) + server (Vercel env) | Secret HMAC push (sama di kedua sisi). |
| `BOT_NOTIFY_URL` | Server (Vercel env) | `https://<domain-bot>/api/notify` (domain deployment bot). |
| `TEAM_ID` | Server (Vercel env) | Id tim server ini di registry bot — tim EL: `raden`. |
| `BOT_NOTIFY_TIMEOUT_MS` | Server (opsional) | Default `1500`. |
| `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` | Bot (Vercel env) | **WAJIB untuk mode Vercel + push** — cursor dedup antar invokasi serverless hanya bertahan lewat Supabase. Tanpa ini, push yang sudah diteruskan bisa dikirim ulang oleh poll (duplikat). Nilai sama dengan env project Vercel server tim. Jalankan `supabase-teams.sql` sekali (sudah termasuk tabel `telegram_poll_state`). |

## Syarat: bot harus punya URL publik

Push hanya bisa diterima endpoint Vercel (`/api/notify`). **Mode lokal
(`local-bot.mjs`) tidak bisa menerima push** — VM tidak punya URL publik
yang bisa dipanggil server. Jadi urutan deploy: bot dulu (Vercel),
baru server. Di mode lokal, jalur keluar tetap poll 1 menit.

## Cara deploy (langkah demi langkah)

> **Jangan deploy sebelum laporan diterima EL.** Semua langkah di bawah
> dilakukan SETELAH persetujuan.

### 1. Deploy bot ke Vercel (kalau belum)

1. Vercel → Add New Project → import repo `muse-team-server` →
   **Root Directory: `telegram-bot`** → Deploy (Hobby, gratis).
2. Settings → Environment Variables — isi (lihat tabel env di README):
   `TELEGRAM_BOT_TOKEN` (ambil lagi dari BotFather — Vault tidak bisa
   membacanya balik), `OWNER_CHAT_ID`, `POLL_SECRET`,
   `BOT_NOTIFY_SECRET` (nilai baru dari `openssl rand -hex 32`),
   `SUPABASE_URL` + `SUPABASE_SERVICE_KEY`, `TELEGRAM_WEBHOOK_SECRET`,
   `TEAMS_JSON` (atau `TEAM_SERVER_URL` + `TEAM_API_KEY` untuk tim utama).
3. Redeploy. Catat domain-nya, mis. `https://muse-team-bot.vercel.app`.
4. Jalankan `supabase-teams.sql` sekali di project Supabase server tim
   (sudah termasuk tabel `telegram_poll_state`).

### 2. Pasang webhook + pemicu poll cadangan

1. Dari VM: `node scripts/set-webhook.mjs https://<domain-bot>/api/webhook`.
2. Buat cron 1 menit di VM: `curl -s "https://<domain-bot>/api/poll?key=<POLL_SECRET>"`
   (cadangan push — lihat "Real-time" di README).

### 3. Deploy patch server

1. Di repo `muse-team-server` (working tree sudah berisi patch, belum
   di-commit): periksa `git status` — yang berubah: `server.js`,
   `package.json`, `notify-bot.js` (baru), `test/test-notify-bot.mjs`
   (baru). Jalankan `npm test` sekali lagi sebelum deploy.
2. Set env di project Vercel **server tim**:
   `BOT_NOTIFY_URL=https://<domain-bot>/api/notify`,
   `BOT_NOTIFY_SECRET=<nilai YANG SAMA dengan di bot>`,
   `TEAM_ID=raden`.
3. Commit + push patch ke branch yang terhubung ke Vercel (auto-deploy).
   Kalau tidak auto-deploy: `vercel --prod` dari root repo.
4. Tunggu deployment selesai; cek `https://muse-team-server.vercel.app/health`
   → `{ ok: true, ... }`.

### 4. Verifikasi setelah deploy

1. **Push pesan:** dari chat EL, kirim pesan biasa ke bot (atau
   `/pesan tes push 1`). Pesan masuk ruang tim, lalu **bot harus
   meneruskannya kembali ke Telegram dalam hitungan detik** — periksa:
   pesan yang sama muncul di chat EL sebagai notifikasi tim
   (`[Tim Raden] 💬 Ell → ruang tim ...`), dan waktunya < 10 detik
   setelah dikirim.
   - Catatan: pesan EL sendiri yang dikirim VIA BOT tidak dipantulkan
     (anti-echo) — yang diverifikasi adalah pesan dari **agent lain**
     (Mas/Mbak) atau pesan EL yang dikirim langsung via dashboard/MCP.
     Cara paling bersih: minta Mas/Mbak kirim satu pesan tes ke ruang
     tim lewat MCP, lalu lihat sampai ke Telegram EL dalam hitungan detik.
2. **Push status/tugas:** ubah satu status/tugas di dashboard tim →
   notifikasi aktivitas sampai ke Telegram dalam hitungan detik.
3. **Tidak duplikat:** tunggu 1–2 menit (satu-dua run poll cadangan) →
   tidak ada pesan yang sama terkirim dua kali. Kalau ada duplikat,
   periksa `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` di env bot dan isi
   tabel `telegram_poll_state` (harus ada 1 baris per tim).
4. **Bot down (opsional):** hentikan bot sebentar (atau cabut webhook)
   → kirim pesan ke tim → pesan tetap sampai lewat poll ~1 menit
   kemudian; log server Vercel menunjukkan `[notify-bot] push ... gagal
   — dilewati, poll cadangan akan meneruskan.` Lalu nyalakan bot lagi.
5. **Rollback (kalau ada masalah):** hapus `BOT_NOTIFY_URL` dari env
   server + redeploy — server kembali ke mode poll saja, bot tetap jalan.
   Tidak ada data yang hilang (state tim tidak disentuh patch ini).

## Batas yang jujur

- Push hanya secepat server tahu: agent sendiri update berkala (Mbak
  tiap 30 detik, Mas maksimal tiap 5 menit, aturan EL 22 Nov) — push
  tidak membuat Mas update lebih cepat. "Instan" = hitungan detik
  **setelah** peristiwa masuk server.
- Push menambah latensi mutasi paling lama 1,5 detik (timeout) saat bot
  down; saat bot sehat ~0,1–0,4 detik.
- Cold start Vercel bot (hitungan detik) menambah jeda push pertama
  setelah lama tidak ada trafik.
- Peristiwa yang tiba tidak berurutan (lebih lama dari cursor) dilewati
  push — poll jendela 2 menit tetap menangkapnya kalau masih di dalam
  jendela.
- Bot hanya meneruskan **teks** (sama seperti poll).
