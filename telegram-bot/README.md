# Bot Telegram — Muse Team Server (multi-tim)

Bot dua arah, pelengkap kantor virtual 3D. EL memakainya dari HP tanpa
buka dashboard. **Satu bot melayani BANYAK tim** — tim EL (Mas, Mbak,
Ell) plus tim bot lain yang gabung nanti.

1. **Server → Telegram** — pesan baru, perubahan status, perubahan
   tugas, anomali dari tiap tim diteruskan ke chat Telegram tim itu,
   **sedekat mungkin dengan real-time** (target ~1 menit setelah masuk
   server — lihat "Real-time" di bawah).
2. **Telegram → server** — EL/pemilik tim membalas / chat / memberi
   perintah ke timnya lewat Telegram. Pesan masuk instan via webhook.

Bot ini **TIDAK mengubah kode server tim yang sudah jalan**. Satu-satunya
yang dipakai dari tiap server adalah API yang sudah ada: `GET /api/state`
(publik), `GET /health` (publik), dan `POST /api/messages` (kunci agent).

## Satu bot untuk semua tim (keputusan desain)

EL bertanya apakah tim lain bisa gabung — jawabannya **satu bot untuk
semua tim** (bukan satu bot per tim):

| | Satu bot (dipilih) | Satu bot per tim |
|---|---|---|
| Token BotFather | 1 | 1 per tim |
| Deploy | 1 project | 1 project per tim |
| EL memantau | 1 chat, pindah tim dengan `/tim` | N chat bot, gampang ketukar |
| Tim baru gabung | `/gabung`, tanpa deploy ulang | Buat bot + deploy baru tiap tim |
| Risiko | Satu titik gagal (bot mati = semua tim diam) | Terisolasi per tim |

Satu titik gagal itu diterima: bot ini stateless (tidak menyimpan apa
pun selain registry tim), jadi hidup lagi begitu proses/deploy jalan
kembali — tidak ada data yang hilang selain jendela poll yang terlewat.

## Isolasi antar tim

Tiap tim punya identitas sendiri di registry:

- `id` (slug, mis. `raden`), `name`, `serverUrl`, `apiKey` (kunci agent),
  `fromAgent`, `agents`, `ownerChatId`, `notifyChatId`, `status`.

Aturan isolasi (dites otomatis — lihat `test/teams.test.mjs`):

- **Pesan dan status tiap tim TERISOLASI.** Poll tim A hanya membaca
  server A dan hanya mengirim ke chat notifikasi A. Perintah dari chat
  tim B tidak pernah menyentuh server A.
- **EL (OWNER_CHAT_ID) = super-owner**: melihat + memerintah SEMUA tim.
- **Pemilik tim lain**: hanya timnya sendiri.
- **Chat grup** yang terikat sebagai `notifyChatId` sebuah tim: tim itu
  saja. Bot harus dimasukkan ke grup itu.
- **Kunci agent tidak pernah keluar** dari jalur pemanggilan server tim
  itu: tidak di-log, tidak di-echo ke Telegram, tidak muncul di
  `/api/health` atau daftar tim.
- **EL beralih antar tim** dengan `/tim <id>` (di chat pribadi EL).
  Chat yang hanya terikat 1 tim selalu memakai tim itu — tidak perlu
  pindah-pindah. Perintah `/status <id-tim>` dan `/tugas <id-tim>`
  bisa mengintip tim lain tanpa pindah.

Pilihan tim aktif per chat disimpan **di memori proses** (Map). Di
runner lokal ini awet selama proses jalan; di Vercel, cold start
mengembalikannya ke tim default (`DEFAULT_TEAM_ID`, lalu tim pertama).
Persistensi pilihan adalah peningkatan v3 (simpan di Supabase).

## Cara tim baru gabung (/gabung)

Tanpa edit kode, tanpa restart bot. Syarat: registry dinamis aktif
(Supabase — lihat "Registry tim" di bawah). Kalau belum aktif, `/gabung`
menolak dengan penjelasan.

**Langkah pemilik tim baru** (di chat pribadi dengan bot, atau di grup
timnya):

1. Kirim `/gabung <id-tim> <url-server> <kunci-agent> [nama-tim]`.
   Contoh: `/gabung kampung https://tim-kampung.vercel.app KUNCI-AGENT "Tim Kampung"`
   - `id-tim`: huruf kecil/angka/`-`, maks 32 karakter.
   - `url-server`: URL server tim itu (harus `https://`).
   - `kunci-agent`: kunci salah satu agent server itu (kunci permanen
     tim tersebut — bot mempelajari agent mana dari jabat tangan).
2. Bot memverifikasi (berurutan):
   - `GET /api/state` — server terjangkau + bentuk state sah.
   - `GET /health` — server sehat (`ok: true`).
   - `POST /api/messages` (jabat tangan) — kunci terbukti sah.
     Server tim **tidak punya endpoint baca yang butuh auth** (semua
     endpoint auth adalah tulis), jadi ini satu-satunya cara membuktikan
     kunci — dan pesannya sekaligus mengumumkan bot ke ruang tim:
     "`[Bot] Bot Telegram terhubung ke tim ini...`". Kalau kunci salah,
     server menjawab 401 dan tim **tidak** terdaftar.
3. Tim aktif seketika (atau `pending` kalau `REQUIRE_EL_APPROVAL=true`
   — EL menyetujui dengan `/setuju <id-tim>`, menolak dengan
   `/tolak <id-tim>`). EL juga diberitahu lewat Telegram.
4. **Hapus pesan `/gabung` dari chat** — pesannya berisi kunci agent.
   Bot berusaha menghapusnya sendiri (best-effort); pemilik tetap
   diminta menghapus manual.

**Setelah gabung**, pemilik tim mengatur notifikasi grup (opsional):
masukkan bot ke grup tim, kirim `/start` di grup (bot membalas chat id
grup), lalu kirim `/notify <id-tim>` **dari grup itu** — notifikasi tim
pindah ke grup. Perintah lain: `/hapus <id-tim>` (pemilik tim / EL).

**Catatan grup + privacy mode:** bot ini (`@SosmedTimbot`) privacy
mode-nya AKTIF (`can_read_all_group_messages: false`). Di grup, bot
hanya menerima **perintah** (`/status`, `/pesan`, ...) dan pesan yang
me-mention bot — pesan biasa di grup TIDAK sampai ke bot. Pakai
perintah di grup, atau matikan privacy via BotFather (`/setprivacy` →
Disable) kalau mau pesan biasa grup juga diteruskan.

## Registry tim

Dua sumber (digabung; yang dinamis menang kalau id bentrok):

| Sumber | Cara ubah | Kapan dipakai |
|---|---|---|
| **Statis** — `TEAMS_JSON` di env (atau tim utama v1 dari `TEAM_SERVER_URL` + `TEAM_API_KEY` kalau `TEAMS_JSON` kosong) | Edit env + redeploy | Tim EL + tim yang sudah dikenal sejak deploy |
| **Dinamis** — tabel `telegram_teams` di Supabase | `/gabung` (runtime, tanpa restart) | Tim lain yang gabung belakangan |

Registry dinamis butuh sekali setup:

1. Jalankan `supabase-teams.sql` di project Supabase **yang sama**
   dengan server tim (SQL Editor → tempel → Run). Tabel memakai RLS
   tanpa policy publik — hanya service_role key (bot, server-side saja)
   yang bisa baca/tulis.
2. Isi `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` di env bot (nilai yang
   sama dengan env project Vercel server tim).

Tanpa keduanya, bot jalan mode statis saja dan `/gabung` menolak dengan
penjelasan.

## Real-time (chat aktif real-time)

**Keputusan EL 27 Nov 14:52: server dorong langsung (instan).**
Jalur utama tim → EL sekarang **push**, bukan poll. Rute poller
10 detik **tidak dipakai** (diputuskan EL — cron mentok 1 menit dan
push instan lebih baik dari poll 10 detikan).

- **Arah EL → tim: instan.** Webhook Telegram memanggil bot begitu EL
  mengirim pesan — tidak ada jeda poll.
- **Arah tim → EL: hitungan detik (push).** Server memanggil bot lewat
  `POST /api/notify` **setiap** ada pesan/status/tugas baru (lihat
  `docs/server-push-patch.md` — patch sudah dibangun + dites, belum
  di-deploy). Pesan sampai ke Telegram EL dalam hitungan detik setelah
  masuk server.
- **Cadangan: poll 1 menit.** Kalau satu push terlewat (bot sempat
  down), poll `GET /api/poll` meneruskannya dalam ~1 menit. Push + poll
  berbagi satu **cursor** per tim (tabel `telegram_poll_state`), jadi
  satu peristiwa tidak pernah diteruskan dua kali.
- **Batas yang jujur:** bot hanya bisa meneruskan secepat server tahu
  — dan agent sendiri update berkala sesuai aturan EL 22 Nov: Mbak
  tiap 30 detik, Mas maksimal tiap 5 menit. Jadi "instan" di sini
  artinya: pesan/status tim sampai ke Telegram EL dalam hitungan detik
  **setelah masuk server**, bukan detik yang sama persis. Kalau Mas baru
  update 5 menit sekali, tidak ada yang bisa membuat pesannya muncul
  lebih cepat dari itu. Push tidak membuat Mas update lebih cepat.

### Syarat push: bot harus di-deploy di Vercel

Server hanya bisa memanggil bot kalau bot punya URL publik
(`https://<domain-bot>/api/notify`). **Mode lokal (`local-bot.mjs`)
tidak bisa menerima push** — VM tidak punya URL publik. Jadi di mode
lokal, jalur keluar tetap poll 1 menit (runner mem-poll sendiri).
Deploy bot dulu (Mode B), baru patch push di server (lihat
`docs/server-push-patch.md` untuk langkah deploy + verifikasi).

### Pemicu poll cadangan: cron 1 menit di VM

Poll sekarang CADANGAN, bukan jalur utama — tapi tetap wajib ada
(supaya peristiwa tidak hilang kalau push terlewat).

**Mode Vercel (webhook): cron 1 menit** — pola yang sama dengan cron
sinkronisasi Ell tiap 1 menit yang sudah jalan. Buat satu cron job:

- **Jadwal:** tiap 1 menit.
- **Tugas:** `curl` endpoint poll bot (ganti domain + secret):
  `curl -s "https://<domain-bot>/api/poll?key=<POLL_SECRET>"`
  — diam kalau sukses, laporkan ke chat utama hanya kalau endpoint
  gagal 3× berturut-turut atau mengembalikan error.
- **Jendela poll:** `POLL_WINDOW_MINUTES=2` (interval 1 menit + 1 menit
  slack, supaya cold start tidak membuat peristiwa terlewat).

**Mode lokal (runner `local-bot.mjs`):** tidak butuh cron luar — runner
itu sendiri mem-poll tiap `POLL_INTERVAL_MINUTES` (default **1** menit)
sambil long-polling pesan masuk. Jalankan sekali, dua arah jalan.

### Pemicu cadangan

| Pemicu | Interval | Catatan |
|---|---|---|
| **Cron 1 menit (UTAMA, cadangan push)** | 1 menit | Lihat di atas. Latensi tim→EL ~1 menit kalau push terlewat. |
| **UptimeRobot (cadangan kedua)** | 5 menit | Monitor HTTP(S) ke `https://<domain-bot>/api/poll?key=<POLL_SECRET>`. Kalau cron 1 menit mati, ini yang menjaga bot tetap hidup. Set `POLL_WINDOW_MINUTES=7` kalau HANYA ini yang dipakai. |
| **Vercel Schedules (beta)** | 15 menit | Pengganti Cron (beta, Nov 2026). Terlalu jarang untuk real-time — hanya darurat. |
| Vercel Cron (legacy) | 1×/hari | **Jangan dipakai** — Hobby dibatasi 1×/hari. |

### Poll + cursor (bukan lagi sekadar jendela waktu)

Function serverless tidak menyimpan apa pun antar request, jadi poller
memakai **jendela waktu**: semua pesan + entri log aktivitas yang
`time`-nya masuk jendela (`POLL_WINDOW_MINUTES`, default 2) dianggap
baru. Aturan: **jendela = interval pemicu + 1 menit**.

Supaya push + poll tidak mengirim peristiwa yang sama dua kali, tiap
tim punya **cursor persisten** (`lib/cursor.js`, tabel
`telegram_poll_state` di Supabase — `supabase-teams.sql`): peristiwa
terakhir yang sudah diteruskan. Poll melewati peristiwa yang sudah ada
di cursor; push memajukan cursor begitu terkirim. **Di mode Vercel,
`SUPABASE_URL` + `SUPABASE_SERVICE_KEY` wajib di-set di bot** —
tanpa itu, dedup antar invokasi serverless tidak jalan dan peristiwa
yang sudah di-push bisa dikirim ulang oleh poll. Di mode lokal, cursor
memori proses cukup (restart mungkin menduplikat satu jendela).

Konsekuensi yang diterima dengan sadar:
- Kalau satu run poll gagal/terlewat, peristiwa di luar jendela tidak
  diteruskan (tidak ada backfill).
- Anomali (agent belum terhubung, tugas macet) hanya **dilampirkan**
  saat ada peristiwa baru lain — bukan notifikasi berdiri sendiri
  (supaya tidak spam tiap menit). Detail lengkap selalu tersedia
  lewat `/status`.

### Identitas pesan EL (penting)

Server tim hanya mengenal kunci agent-nya. Bot mengirim pesan EL
dengan kunci agent tim itu (`fromAgent` — untuk tim EL default `ell`,
untuk tim gabung dipelajari dari jabat tangan) — jadi di dashboard,
pesan EL tercatat sebagai pesan dari agent itu. Supaya tidak
membingungkan, **setiap pesan EL diberi prefix `[EL] `** di teksnya,
dan poller **tidak pernah** meneruskan pesan ber-prefix `[EL] ` atau
`[Bot] ` balik ke Telegram (anti-pantul).

Opsi yang lebih rapi (butuh perubahan kecil di server — **belum**
dilakukan, perlu keputusan EL): tambah agent `el` (EL/Pemilik) dengan
kunci sendiri di server. Pesan EL lalu tercatat atas nama EL sendiri.
Scaffold ini sudah siap untuk itu — tinggal set `fromAgent: "el"` di
registry tim itu + kunci EL.

## Kredensial Telegram (terverifikasi)

- **Bot: @SosmedTimbot** ("My muse Tim", id 9275764510) — terverifikasi
  27 Nov 2026.
- **Token tersimpan sebagai konektor `custom.telegram`** (Secure Vault).
  Helper API yang jalan: `~/workspace/custom-connectors/custom.telegram/bin/tg.py`
  (`getme`, `send`, `getupdates`, `setwebhook`, `deletewebhook`,
  `webhookinfo`, `deletemessage`) — dokumentasi lengkap di
  `~/workspace/custom-connectors/custom.telegram/CONNECTOR.md`.
- **Pola panggil yang WAJIB dipakai:** ambil surrogate via
  `dynamic_credential_entry("custom.telegram", "access_token")` lalu
  sisipkan **mentah** ke path URL
  (`https://api.telegram.org/bot<surrogate>/METHOD`) — **tanpa
  percent-quoting**. Helper `url_with_surrogate_path_segment`
  meng-quote surrogate (`hsurr%3A...`) sehingga swap di egress gagal
  dan Telegram menjawab 404. `tg.py` sudah memakai pola yang benar;
  `scripts/tg-bridge.mjs` membungkusnya untuk Node.
- **Jangan pernah** menulis nilai token/kunci di file, env yang
  di-commit, argumen command, atau log. Token di `TELEGRAM_BOT_TOKEN`
  (mode Vercel) hanya ditempel sekali dari BotFather ke env Vercel —
  salinan di Vault **tidak bisa dibaca balik**, jadi ambil dari
  BotFather lagi saat deploy Vercel.
- Perintah berguna (dari VM ini):
  `tg.py getme` (cek identitas bot), `tg.py send --chat-id <id> --text <pesan>`,
  `tg.py getupdates`, `tg.py setwebhook --url <https> --secret <secret>`,
  `tg.py webhookinfo`, `tg.py deletewebhook`.

## Perintah bot

| Perintah | Fungsi |
|---|---|
| `/start` | Perkenalan + daftar tim (atau chat id kalau OWNER_CHAT_ID belum di-set) |
| `/tim` | Daftar tim yang bisa kamu akses |
| `/tim <id>` | Pindah tim aktif di chat ini |
| `/status [tim]` | Status + aktivitas tim aktif (atau tim lain) |
| `/tugas [tim]` | Daftar tugas tim aktif (atau tim lain) |
| `/pesan <teks>` | Kirim pesan ke ruang tim aktif |
| `/dm <agent> <teks>` | Kirim DM ke satu agent tim aktif |
| `/gabung <id> <url> <kunci> [nama]` | Daftarkan tim baru (lihat atas) |
| `/notify <id>` | Jadikan chat/grup ini tujuan notifikasi tim itu |
| `/setuju <id>` / `/tolak <id>` | (EL) Setujui/tolak tim pending |
| `/hapus <id>` | (EL/pemilik) Hapus tim dari bot |
| `/help` | Daftar perintah |
| pesan biasa | Langsung terkirim ke ruang tim aktif |

## Env var

Semua rahasia **hanya lewat env var** (Vercel → Settings → Environment
Variables, atau `.env` lokal yang tidak di-commit). Tidak ada token/kunci
di kode atau di log. Lihat `.env.example` untuk daftar lengkap.

| Var | Wajib | Keterangan |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Vercel saja | Token dari @BotFather (lihat "Kredensial Telegram") |
| `OWNER_CHAT_ID` | Ya | Chat id Telegram EL/super-owner (dari `/start`) |
| `POLL_SECRET` | Vercel saja | String acak (`openssl rand -hex 24`), pengaman `/api/poll` |
| `BOT_NOTIFY_SECRET` | Vercel saja | String acak (`openssl rand -hex 32`), secret HMAC push `/api/notify` — **nilai yang sama** harus di-set di server tim (`BOT_NOTIFY_SECRET` + `BOT_NOTIFY_URL` + `TEAM_ID`, lihat `docs/server-push-patch.md`) |
| `TEAMS_JSON` | Tidak | Daftar tim statis (JSON array). Kosong = tim utama v1 |
| `TEAM_SERVER_URL` | Tidak | Default `https://muse-team-server.vercel.app` (tim utama v1) |
| `TEAM_API_KEY` | Tidak | Kunci agent tim utama v1 |
| `BOT_FROM_AGENT_ID` | Tidak | Default `ell` (tim utama v1) |
| `DEFAULT_TEAM_ID` | Tidak | Tim aktif default di chat EL (default tim pertama) |
| `REQUIRE_EL_APPROVAL` | Tidak | `"true"` = tim gabung berstatus pending, EL menyetujui |
| `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` | Dinamis | Nilai yang sama dengan env server tim; mengaktifkan `/gabung` |
| `TELEGRAM_WEBHOOK_SECRET` | Tidak | String acak, validasi webhook Telegram (Vercel saja) |
| `POLL_WINDOW_MINUTES` | Tidak | Default `2` (= interval pemicu 1 menit + 1) |
| `MAX_EVENTS_PER_RUN` | Tidak | Default `10` per tim per run |
| `POLL_INTERVAL_MINUTES` | Tidak | Interval poll runner lokal (default `1`) |

## Cara jalan (pilih satu mode)

### Mode A — Lokal di VM (disarankan)

Tanpa deploy, tanpa token di env — semua panggilan Telegram lewat
konektor `custom.telegram` (Secure Vault):

1. **Registry:** isi `TEAMS_JSON` di `.env` (atau `TEAM_SERVER_URL` +
   `TEAM_API_KEY` untuk tim utama saja). Untuk `/gabung`, set
   `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` + jalankan
   `supabase-teams.sql` sekali.
2. **Hapus webhook kalau pernah ada:** `tg.py deletewebhook`
   (webhook dan long-polling saling meniadakan).
3. **Jalan:** `npm run local` (atau `node scripts/local-bot.mjs`).
   Bot long-polling pesan masuk + mem-poll semua tim tiap 1 menit.
4. **EL kirim `/start`** ke @SosmedTimbot → bot membalas → isi
   `OWNER_CHAT_ID` di `.env` → restart runner → kirim `/start` lagi.

Catatan: proses ini mati kalau VM di-restart/diganti (seperti
FreeLLMAPI) — jalankan ulang dengan perintah di atas. Untuk
keandalan, jalankan di bawah `systemd`/cron `@reboot` (lihat
`scripts/local-bot.mjs`).

### Mode B — Vercel (webhook)

1. **BotFather**: token sudah ada di Vault — ambil lagi dari BotFather
   (`/mybots` → bot → API Token) untuk ditempel ke Vercel (Vault tidak
   bisa membacanya balik).
2. **Vercel → Add New Project** → import repo `muse-team-server` →
   **Root Directory: `telegram-bot`** (project terpisah dari server tim)
   → Deploy (Hobby, gratis).
3. **Settings → Environment Variables**: isi var wajib + opsional →
   Redeploy.
4. **Pasang webhook** (sekali, dari VM ini):
   `node scripts/set-webhook.mjs https://<domain-bot>/api/webhook`
5. **Pemicu poll cadangan — cron 1 menit** (lihat "Real-time"): cron job
   `curl -s "https://<domain-bot>/api/poll?key=<POLL_SECRET>"` tiap
   1 menit. **Cadangan:** UptimeRobot tiap 5 menit ke URL yang sama.
6. **Aktifkan server push** (instan, hitungan detik — keputusan EL
   27 Nov): ikuti `docs/server-push-patch.md` — set `BOT_NOTIFY_URL` +
   `BOT_NOTIFY_SECRET` + `TEAM_ID` di env project Vercel **server tim**,
   lalu deploy patch server (`server.js` + `notify-bot.js`).
   Tanpa langkah ini, bot jalan dengan poll 1 menit saja.
7. **EL kirim `/start`** ke bot → isi `OWNER_CHAT_ID` → Redeploy →
   kirim `/start` lagi.

Tes sebelum deploy (tanpa Vercel, tanpa webhook):
`npm run local` — coba `/status`, `/tugas`, `/tim`, dan satu pesan
biasa, lalu cek masuk ke ruang tim di dashboard.

## Keamanan

- Hanya chat yang terikat tim (atau super-owner) yang dilayani;
  `/gabung` adalah satu-satunya perintah untuk chat asing.
- Webhook divalidasi secret Telegram (`X-Telegram-Bot-Api-Secret-Token`).
- `/api/poll` butuh `POLL_SECRET` (header Bearer atau `?key=`).
- Registry dinamis di Supabase: RLS aktif tanpa policy publik, hanya
  service_role key (server-side) yang bisa baca/tulis.
- Bot hanya memanggil `GET /api/state`, `GET /health` (publik) dan
  `POST /api/messages` di server tiap tim — tidak pernah menyentuh
  tugas/status agent lain, tidak mengubah state server selain mengirim
  pesan (+ satu pesan jabat tangan saat `/gabung`).
- Pesan error tidak pernah membawa nilai kunci (server sudah meredaksi
  pola JWT; bot hanya mencatat `e.message`; `/gabung` tidak pernah
  meng-echo kunci ke Telegram).

## Struktur file

```text
telegram-bot/
├── README.md            # dokumen ini
├── package.json         # type: module, TANPA dependensi (fetch bawaan Node 18+)
├── .env.example         # nama var saja — tanpa nilai
├── supabase-teams.sql   # tabel registry tim dinamis + cursor poll (jalankan sekali)
├── docs/
│   └── server-push-patch.md  # desain + cara deploy server push (instan)
│   └── server-push.patch     # diff patch server (siap di-apply)
├── api/
│   ├── webhook.js       # POST /api/webhook — pesan masuk dari Telegram
│   ├── poll.js          # GET  /api/poll    — polling outbound cadangan (dipicu luar, 1 menit)
│   ├── notify.js        # POST /api/notify  — push instan dari server tim (HMAC)
│   └── health.js        # GET  /api/health  — cek hidup + daftar tim (tanpa kunci)
├── lib/
│   ├── config.js        # baca env (tidak pernah log nilainya)
│   ├── registry.js      # registry multi-tim: statis (env) + dinamis (Supabase),
│   │                    #   isolasi, routing chat->tim, pilihan tim aktif
│   ├── teamApi.js       # GET /api/state + /health, POST /api/messages (per tim),
│   │                    #   verifyTeamConnection (jabat tangan /gabung)
│   ├── telegram.js      # sendMessage / getUpdates / setWebhook / deleteMessage
│   │                    #   (mode Vercel, token env — mentah di path, tanpa quote)
│   ├── pollTeams.js     # poll SEMUA tim aktif (dipakai api/poll + local-bot)
│   ├── cursor.js        # cursor dedup push-vs-poll per tim (Supabase + memori)
│   ├── notify.js        # verifikasi HMAC + normalisasi peristiwa push
│   ├── diff.js          # peristiwa baru dalam jendela waktu + anomali
│   ├── format.js        # format teks Indonesia (WIB, escape HTML)
│   └── commands.js      # /start /tim /status /tugas /pesan /dm /gabung
│                        #   /notify /setuju /tolak /hapus /help + pesan biasa
├── scripts/
│   ├── tg-bridge.mjs    # jembatan Node -> tg.py (konektor custom.telegram)
│   ├── local-bot.mjs    # runner lokal: long-poll masuk + poll keluar 1 menit
│   └── set-webhook.mjs  # pasang webhook sekali saat deploy Vercel
└── test/
    ├── diff.test.mjs      # 4 tes logika diff/anomali
    ├── commands.test.mjs  # 17 tes perintah + isolasi + onboarding
    ├── teams.test.mjs     # 14 tes registry (isolasi, routing, pendaftaran)
    ├── poll.test.mjs      # 5 tes poll multi-tim (isolasi, jendela 1 menit)
    ├── cursor.test.mjs    # 10 tes cursor dedup push-vs-poll
    └── notify.test.mjs    # 10 tes endpoint push (HMAC, dedup, echo)
```

Tes: `npm test` (60 tes, tanpa jaringan, tanpa token).

## Batasan (jujur)

- **Push butuh bot di Vercel** (URL publik). Mode lokal tidak bisa
  menerima push — jalur keluarnya tetap poll 1 menit.
- **Push butuh Supabase di env bot** (mode Vercel) — tanpa itu, dedup
  push-vs-poll antar invokasi tidak jalan dan peristiwa yang sudah
  di-push bisa dikirim ulang oleh poll.
- Poller berbasis jendela waktu: peristiwa di luar jendela tidak
  diteruskan kalau run poll gagal/terlewat.
- Notifikasi anomali hanya lampiran (bukan alert berdiri sendiri).
- Pesan EL tercatat atas nama agent pengirim (`fromAgent` tim itu)
  dengan prefix `[EL] ` — sampai server (opsional) menambah agent `el`.
- Pilihan tim aktif per chat disimpan di memori proses — cold start
  Vercel mengembalikannya ke tim default.
- Bot hanya meneruskan **teks**. Foto/file/voice dari EL tidak
  diteruskan ke tim (Telegram mengirimnya sebagai update non-teks —
  bot membalas bahwa hanya teks yang diteruskan).
- Di grup dengan privacy mode aktif, pesan biasa tidak sampai ke bot —
  pakai perintah (atau matikan privacy via BotFather).
- Mode lokal mati kalau VM di-restart/diganti — jalankan ulang runner.
- Cold start Vercel (hitungan detik) menambah jeda notifikasi pertama
  setelah lama tidak ada trafik (mode Vercel).
- Push menambah latensi mutasi server paling lama 1,5 detik saat bot
  down (timeout); saat bot sehat ~0,1–0,4 detik.

## Yang masih butuh dari EL

1. ~~**Token bot dari @BotFather**~~ — **SUDAH ADA** (tersimpan sebagai
   konektor `custom.telegram`; bot @SosmedTimbot terverifikasi 27 Nov).
   Untuk deploy Vercel, EL ambil lagi tokennya dari BotFather
   (`/mybots` → API Token) karena Vault tidak bisa membacanya balik.
2. **Chat id** — EL kirim `/start` ke bot setelah jalan (bot membalas
   dengan angkanya) — atau EL kirim angkanya langsung kalau sudah tahu.
3. **Nama bot** — sudah ada (@SosmedTimbot, "My muse Tim"). Ganti nama
   hanya lewat BotFather (`/setname`) kalau EL mau.
4. **Pemicu poll cadangan (mode Vercel)** — cron 1 menit di VM
   (disarankan, lihat "Real-time") atau UptimeRobot 5-menitan sebagai
   cadangan kedua. Mode lokal tidak butuh ini (runner mem-poll sendiri
   tiap 1 menit).
5. **Deploy server push (instan)** — patch sudah dibangun + dites
   (lihat `docs/server-push-patch.md` + `docs/server-push.patch`), TAPI
   belum di-deploy. Perlu persetujuan EL untuk: deploy bot ke Vercel
   dulu, lalu commit + push patch server (env baru `BOT_NOTIFY_URL` +
   `BOT_NOTIFY_SECRET` + `TEAM_ID`). Tanpa ini, bot jalan dengan poll
   1 menit saja.
6. **Keputusan identitas** — tetap `[EL] ` via kunci agent (tanpa ubah
   server), atau tambah agent `el` di server (perubahan kecil, perlu
   persetujuan eksplisit karena menyentuh server yang sudah jalan).
7. **Tingkat kebisingan notifikasi** — v2 meneruskan semua pesan +
   semua perubahan status/tugas tiap tim. Kalau terlalu ramai, bisa
   dipersempit (mis. hanya pesan + tugas selesai/macet) — tinggal ubah
   filter di `lib/diff.js`.
8. **Persetujuan tim baru** — default tim gabung langsung aktif. Kalau
   EL mau menyetujui tiap tim baru dulu, set `REQUIRE_EL_APPROVAL=true`
   (lalu `/setuju` / `/tolak` tiap pendaftar).
