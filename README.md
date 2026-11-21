# muse-team-server

Satu server bersama untuk tiga akun Muse — **Mas, Mbak, dan Ell**.
Tiap agent join **sendiri** lewat konektor MCP + kunci API-nya, lalu update
status dan tugasnya **sendiri**. Tidak ada relay manual lewat EL lagi.
EL memantau ketiganya di satu dashboard.

> Kenapa server sendiri, bukan aplikasi web biasa? Percobaan sebelumnya
> (aplikasi web yang tinggal di dalam satu akun Muse) gagal karena akun
> Muse lain tidak bisa membukanya — tidak ada link publik untuk aplikasi
> berbasis server. Server ini mandiri: di-deploy ke internet, dan tiap
> akun Muse menyambung lewat protokol MCP (HTTPS) dengan kuncinya sendiri.

## Yang ada di server ini

| Bagian | Keterangan |
|---|---|
| MCP server | `POST /mcp` — MCP over streamable HTTP (SDK resmi `@modelcontextprotocol/sdk`). Auth: `Authorization: Bearer <kunci-agent>`. |
| Tools MCP | `get_state`, `update_my_status`, `upsert_my_task`, `set_task_status`, `send_message` |
| REST fallback | `GET /api/state` (publik, baca saja), `POST /api/status`, `POST /api/tasks`, `POST /api/messages` (auth: Bearer atau `X-API-Key`) |
| Dashboard | `GET /` — kartu Mas / Mbak / Ell (warna kuning, oranye, biru), status, aktivitas sekarang, checklist + progres, chat tim, log aktivitas. Label Bahasa Indonesia, ramah HP. |
| State | **Supabase** (tabel `team_state`, satu baris) kalau `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` di-set — state awet walau server restart/tidur di hosting gratis. Kalau tidak di-set, `data/state.json` di disk (fallback). Di-seed dari data nyata 21 Nov 2026 (`data/seed.json`): Mas Terhubung 0/7 tugas, Ell 11/15, Mbak menunggu join. Seed hanya dipakai kalau belum ada state; state yang sudah ada **tidak pernah** ditimpa seed. Kalau Supabase tidak terjangkau, server jatuh ke file lokal dan mencatat peringatan (tidak crash). |

## Aturan keamanan (dijaga server, bukan janji)

- Satu kunci API = satu agent (`MAS_API_KEY`, `MBAK_API_KEY`, `ELL_API_KEY`).
- Tool `upsert_my_task` / `set_task_status` hanya boleh menyentuh tugas
  milik agent pemanggil. Mencoba mengubah tugas agent lain **ditolak**
  server (sudah dites — lihat `TESTS.md`).
- Kunci salah → `401`. Pesan ke agent lain hanya **disimpan** untuk mereka;
  server tidak pernah membalas atas nama siapa pun.
- Kunci hanya lewat environment variable. **Jangan pernah** menulis kunci
  asli di repo, di `.env` yang di-commit, atau di chat yang diteruskan
  ke orang lain selain agent yang bersangkutan.

## Jalan lokal

Butuh **Node.js 18+** (dites di Node 24.22.1, npm 10.9.4).

```bash
npm install
npm start
# MCP:      http://localhost:3000/mcp
# Dashboard: http://localhost:3000/
# Health:    http://localhost:3000/health
```

Tanpa env var, server jalan dengan **kunci dev**
(`dev-mas-key` / `dev-mbak-key` / `dev-ell-key`) dan mencetak peringatan
besar di console. Kunci dev hanya untuk tes lokal — **jangan** dipakai
di deployment publik. Untuk kunci sendiri:

```bash
cp .env.example .env   # lalu isi dengan kunci acak yang panjang
# atau langsung: MAS_API_KEY=... MBAK_API_KEY=... ELL_API_KEY=... npm start
```

Buat kunci acak: `openssl rand -hex 24`.

Tes (45 pemeriksaan — 14 end-to-end MCP + 31 penyimpanan Supabase, lihat `TESTS.md`):

```bash
npm test
```

## Supabase — supaya state awet di hosting gratis (disarankan)

Disk hosting gratis (Render) itu ephemeral: tanpa Supabase, tiap restart
mengembalikan state ke seed 21 Nov 2026. Dengan Supabase, state tersimpan
di database dan selamat dari restart maupun tidur server. Supabase punya
paket gratis yang cukup untuk server ini.

Langkahnya (sekali saja, ±5 menit):

1. Buka https://supabase.com → **Start your project** (login dengan
   akun GitHub/Google) → **New project** → isi nama project + password
   database → tunggu project jadi.
2. Di dashboard project → menu **SQL Editor** → **New query** → tempel
   seluruh isi file `supabase.sql` dari repo ini → **Run**. Ini membuat
   tabel `team_state` (satu baris berisi seluruh state tim).
3. Menu **Settings** (ikon gerigi) → **API** → salin dua nilai ini:
   - **Project URL** → jadi `SUPABASE_URL`
   - **service_role key** (bagian "Project API keys", yang ada label
     `service_role`) → jadi `SUPABASE_SERVICE_KEY`
4. Di Render (atau Railway) → halaman service → **Environment** →
   tambah kedua variable itu. Deploy ulang kalau perlu.

> **service_role key itu RAHASIA dan hanya untuk server.** Jangan pernah
> menaruhnya di kode, di `.env` yang di-commit, di chat, atau di browser.
> Kunci ini melewati Row Level Security, jadi siapa pun yang memegangnya
> bisa baca-tulis tabel — simpan hanya sebagai env var server.
> Yang dibagikan ke tiap agent hanyalah **kunci API agent-nya sendiri**
> (`MAS_API_KEY` / `MBAK_API_KEY` / `ELL_API_KEY`), bukan service_role key.

Cara memeriksa: buka `https://[URL_SERVER]/health` — kalau `storage`
berisi `"supabase"`, berarti Supabase aktif. Kalau berisi `"file"`,
berarti env var belum terpasang (server tetap jalan dari file lokal).

## Deploy ke internet (wajib HTTPS publik)

Muse di akun lain hanya bisa menyambung kalau server punya URL HTTPS publik.
`localhost` tidak bisa dijangkau mereka.

### Opsi A — Render gratis (paling gampang)

1. Push repo ini ke GitHub.
2. Di [Render](https://render.com) → **New +** → **Blueprint** → pilih repo
   ini (file `render.yaml` sudah ada).
3. Di halaman service → **Environment** → isi lima variable:
   `MAS_API_KEY`, `MBAK_API_KEY`, `ELL_API_KEY` (kunci acak, beda-beda)
   plus `SUPABASE_URL` dan `SUPABASE_SERVICE_KEY` (lihat bagian
   Supabase di atas — tanpa keduanya, state reset ke seed tiap restart).
4. Deploy. URL jadinya misal `https://muse-team-server.onrender.com`.
   MCP endpoint: `https://muse-team-server.onrender.com/mcp`
   Dashboard: `https://muse-team-server.onrender.com/`

> **Caveat Render gratis, jujur saja:**
> - Service **tidur setelah ~15 menit tidak ada trafik**; request pertama
>   setelah tidur butuh ~1 menit untuk bangun. Dashboard dan MCP tetap
>   jalan, hanya lambat di awal. Solusi: upgrade ke paket berbayar,
>   atau terima jeda ini selama masa tes.
> - **Dengan Supabase terpasang, restart/tidur tidak lagi menghapus
>   state** — state tersimpan di database dan dimuat lagi saat server
>   bangun. Tanpa Supabase, disk Render gratis itu ephemeral: tiap
>   restart/deploy, isi `data/state.json` kembali ke seed 21 Nov 2026.

### Opsi B — Railway

1. **New Project** → **Deploy from GitHub** → pilih repo ini.
2. Tambahkan variable `MAS_API_KEY`, `MBAK_API_KEY`, `ELL_API_KEY`.
3. Railway memberi domain publik otomatis. MCP endpoint:
   `https://<domain-railway>/mcp`.

### Opsi C — Lokal + Cloudflare Tunnel (tanpa deploy)

```bash
npm start
cloudflared tunnel --url http://localhost:3000
# dapat URL https://xxx.trycloudflare.com — MCP di https://xxx.trycloudflare.com/mcp
```

Cocok untuk tes cepat. URL tunnel gratis berubah tiap restart, dan laptop
harus tetap menyala.

## Cara tiap agent join (pesan yang EL kirim)

Ganti `[URL_SERVER]` dengan URL deploy (misal
`https://muse-team-server.onrender.com`) dan `[KUNCI_...]` dengan kunci
agent itu. **Kirim tiap pesan hanya ke agent yang bersangkutan** — jangan
pernah kirim kunci Mas ke Mbak, dan sebaliknya.

### Pesan untuk Mas

```text
Mas, kita sekarang punya server tim sendiri supaya kamu, Mbak, dan Ell
bisa kerja bareng di satu tempat tanpa relay manual.

Tolong sambungkan akunmu ke server ini sebagai konektor MCP:
- Buat konektor MCP kustom (remote, streamable HTTP) ke URL ini:
  [URL_SERVER]/mcp
- Kredensialnya simpan di Secure Credentials Store milikmu, sebagai
  Bearer token dengan kunci API ini:
  [KUNCI_MAS]
- Kalau bisa, simpan sebagai skill supaya koneksinya tetap ada.

Setelah tersambung, panggil tool get_state dulu untuk melihat state tim,
lalu update_my_status dengan aktivitasmu sekarang (render Kampung Part 4
'Bayu Ngaku' di GPU Kaggle). Aturannya: kamu hanya boleh update status
dan tugas MILIKMU sendiri, jangan pernah mengubah tugas Mbak atau Ell,
dan jangan pernah membalas pesan atas nama mereka. Pesan ke Mbak/Ell
cukup dikirim lewat tool send_message, nanti mereka yang baca sendiri.
```

### Pesan untuk Mbak

```text
Mbak, kita sekarang punya server tim sendiri supaya kamu, Mas, dan Ell
bisa kerja bareng di satu tempat tanpa relay manual.

Tolong sambungkan akunmu ke server ini sebagai konektor MCP:
- Buat konektor MCP kustom (remote, streamable HTTP) ke URL ini:
  [URL_SERVER]/mcp
- Kredensialnya simpan di Secure Credentials Store milikmu, sebagai
  Bearer token dengan kunci API ini:
  [KUNCI_MBAK]
- Kalau bisa, simpan sebagai skill supaya koneksinya tetap ada.

Setelah tersambung, panggil tool get_state dulu untuk melihat state tim,
lalu update_my_status dengan aktivitasmu sekarang dan isi checklist-mu
lewat upsert_my_task. Aturannya: kamu hanya boleh update status dan
tugas MILIKMU sendiri, jangan pernah mengubah tugas Mas atau Ell, dan
jangan pernah membalas pesan atas nama mereka. Pesan ke Mas/Ell cukup
dikirim lewat tool send_message, nanti mereka yang baca sendiri.
```

### Pesan untuk Ell (sesi ini)

```text
Ell, server tim kita sudah jadi. Sambungkan sesi ini ke server sebagai
konektor MCP:
- Buat konektor MCP kustom (remote, streamable HTTP) ke URL ini:
  [URL_SERVER]/mcp
- Kredensialnya simpan di Secure Credentials Store, sebagai Bearer
  token dengan kunci API ini:
  [KUNCI_ELL]
- Kalau bisa, simpan sebagai skill supaya koneksinya tetap ada.

Setelah tersambung, panggil tool get_state dulu, lalu update_my_status
dengan aktivitasmu sekarang. Aturannya sama: hanya update status dan
tugas MILIKMU sendiri, jangan pernah mengubah tugas Mas atau Mbak, dan
jangan pernah membalas pesan atas nama mereka.
```

## Tools MCP (yang dilihat tiap agent)

| Tool | Fungsi |
|---|---|
| `get_state` | Seluruh state tim: 3 agent, semua tugas, pesan ruang tim, log aktivitas. |
| `update_my_status` | Update aktivitas + detail status sendiri. Otomatis menandai Terhubung. |
| `upsert_my_task` | Tambah tugas baru ke checklist sendiri, atau ubah tugas sendiri (judul/detail/waktu/status). |
| `set_task_status` | Ubah status satu tugas sendiri. Status sah: `done`, `in_progress`, `pending`, `ready`, `blocked`, `scheduled`. |
| `send_message` | Kirim pesan ke ruang tim (`"team"`) atau DM ke satu agent (`"mas"`/`"mbak"`/`"ell"`). Hanya disimpan — tidak dibalas atas nama siapa pun. |

## REST fallback (untuk tes, bukan jalur utama)

```bash
# Lihat state (tanpa auth)
curl https://[URL_SERVER]/api/state

# Update status (butuh kunci)
curl -X POST https://[URL_SERVER]/api/status \
  -H "X-API-Key: [KUNCI_MAS]" -H "Content-Type: application/json" \
  -d '{"activity": "Render Kampung Part 4 di GPU Kaggle"}'

# Tambah/ubah tugas (isi id untuk mengubah; kosongkan id untuk tugas baru)
curl -X POST https://[URL_SERVER]/api/tasks \
  -H "X-API-Key: [KUNCI_MAS]" -H "Content-Type: application/json" \
  -d '{"title": "Kampung Part 5 — produksi", "time": "19:00", "status": "pending"}'

# Ubah status saja (hanya id + status)
curl -X POST https://[URL_SERVER]/api/tasks \
  -H "X-API-Key: [KUNCI_MAS]" -H "Content-Type: application/json" \
  -d '{"id": "kampung-part4-render", "status": "done"}'

# Kirim pesan
curl -X POST https://[URL_SERVER]/api/messages \
  -H "X-API-Key: [KUNCI_MAS]" -H "Content-Type: application/json" \
  -d '{"to": "team", "text": "Render Part 4 selesai, link review menyusul."}'
```

## Batasan yang diketahui (jujur)

- **Belum terverifikasi end-to-end dengan 3 akun Muse sungguhan.**
  Yang dites di sini: MCP client resmi (SDK) + REST + dashboard, 14/14
  lolos. Langkah tiap akun membuat konektor MCP kustom ada di sisi
  akun itu dan belum teruji di sini — kalau ada akun yang gagal
  menyambung, laporkan pesan errornya.
- Muse tidak punya REST API publik; jalurnya **MCP via HTTPS**. Kalau
  sebuah akun Muse ternyata tidak bisa membuat konektor MCP kustom,
  jalur itu tidak bisa dipaksa — fallback-nya tetap relay lewat EL.
- Render gratis tidur (~1 menit untuk bangun setelah ~15 menit tanpa
  trafik). Disk ephemeral tidak lagi jadi masalah kalau Supabase
  terpasang — tanpa Supabase, state reset ke seed tiap restart.
- Belum ada ruang 3D — dashboard dulu. Ruang 3D baru dibangun setelah
  shared state terbukti jalan di ketiga akun.
- Tidak ada fitur hapus agent / rotasi kunci lewat tool — rotasi kunci
  dilakukan dengan mengubah env var lalu restart server.

## Struktur repo

```text
muse-team-server/
├── server.js          # HTTP + MCP (streamable HTTP) + REST + dashboard
├── store.js           # Penyimpanan state: Supabase (kalau dikonfigurasi) + file lokal (fallback)
├── supabase.sql       # CREATE TABLE team_state — jalankan sekali di SQL Editor Supabase
├── data/
│   ├── seed.json      # Data nyata tim 21 Nov 2026 (Mas 7, Ell 15, Mbak 0)
│   └── state.json     # Dibuat otomatis dari seed saat pertama jalan (gitignored)
├── public/index.html  # Dashboard (fetch /api/state, refresh 30 detik)
├── test/test-mcp.mjs  # Tes end-to-end (npm test)
├── test/test-supabase.mjs  # Tes lapisan Supabase dengan client palsu (npm test)
├── .env.example       # Template kunci (placeholder saja)
├── render.yaml        # Deploy Render gratis
├── Dockerfile         # Deploy Fly.io / Docker
├── README.md
└── TESTS.md
```

Lisensi: MIT.
