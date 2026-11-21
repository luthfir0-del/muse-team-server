# Hasil Tes — muse-team-server

Jalankan: `npm test` (skrip `test/test-mcp.mjs` lalu
`test/test-supabase.mjs`).

## Ringkasan

| Tanggal | Node | Hasil |
|---|---|---|
| 21 Nov 2026 | 24.22.1 | **16 lolos, 0 gagal** (MCP end-to-end, stateless) |
| 21 Nov 2026 | 24.22.1 | **47 lolos, 0 gagal** (16 MCP + 31 Supabase) |

Tes menyalakan server sendiri di port 3457 (MCP) / 3458 (Supabase) dengan
`STATE_FILE` sementara (salinan `data/seed.json`), jadi `data/state.json`
asli tidak tersentuh. Server dimatikan otomatis setelah tes selesai.

## Yang dites

1. Server nyala (`/health`).
2. Seed termuat benar: Mas 7 tugas.
3. Seed termuat benar: Ell 15 tugas, 11 selesai.
4. Seed termuat benar: Mbak 0 tugas, status pending.
5. MCP `tools/list`: 5 tool (`get_state`, `update_my_status`,
   `upsert_my_task`, `set_task_status`, `send_message`).
5b. **Stateless**: `initialize` mentah (tanpa sesi) → 200 dan respons
   **tanpa** header `mcp-session-id` (server tidak membuat sesi).
6. MCP `update_my_status` (Ell) mengubah state.
7. MCP `set_task_status` pada tugas sendiri berhasil.
8. MCP `upsert_my_task` (tugas baru) berhasil.
9. MCP `send_message` ke ruang tim tersimpan.
9b. **Stateless**: client MCP **baru** (tanpa sesi apa pun) memanggil
   `get_state` dan melihat status + pesan yang ditulis Ell — tiap
   request berdiri sendiri, tidak ada afinitas sesi.
10. Kunci API salah ditolak (HTTP 401).
11. Mas **tidak bisa** mengubah tugas Ell (server menolak).
12. Mas **bisa** mengubah tugasnya sendiri.
13. REST `POST /api/status` (Mbak, header `X-API-Key`) berhasil.
14. Dashboard `/` tersaji (mengandung "Ruang Kerja Bersama").

## Tes penyimpanan Supabase (baru — `test/test-supabase.mjs`)

Memakai **Supabase palsu** (class tiruan yang meniru rantai postgrest-js),
bukan project sungguhan — tanpa kredensial asli sama sekali.

1. `supabaseConfigured`: env kosong → false; env lengkap → true.
2. Hanya satu dari `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` di-set →
   client null + peringatan.
3. Tanpa env → client null (mode file).
4. File-only: backend = `file`, load seed dari `seed.json` (Mas 7 tugas).
5. File-only: `state.json` dibuat di disk.
6. File-only: persist tulis file, tanpa Supabase.
7. File-only: tanpa peringatan.
8. Supabase: backend = `supabase`.
9. Supabase ada baris: load menang dari Supabase (bukan dari file lokal
   yang isinya beda).
10. Supabase: file lokal ikut disinkronkan dari Supabase saat load.
11. Supabase: load memanggil select.
12. Supabase baris kosong: load mengembalikan seed (Mas 7 tugas).
13. Supabase baris kosong: seed di-upsert ke Supabase (id = 1, 22 tugas).
14. Supabase baris kosong: file lokal dibuat.
15. Supabase: persist mengembalikan true.
16. Supabase: upsert tercatat dengan state baru.
17. Supabase: file lokal ikut diperbarui saat persist.
18. Supabase select gagal: load tidak melempar.
19. Supabase select gagal: fallback ke file lokal.
20. Supabase select gagal: peringatan dicatat.
21. Supabase upsert gagal: persist tidak melempar.
22. Supabase upsert gagal: persist mengembalikan false.
23. Supabase upsert gagal: file lokal tetap diperbarui.
24. Supabase upsert gagal: peringatan dicatat.
25. Integrasi: server nyala walau `SUPABASE_URL` tidak terjangkau
    (http://127.0.0.1:9).
26. Integrasi: `/health` melaporkan `storage: "supabase"` (terkonfigurasi).
27. Integrasi: state dari file (Mas 7 tugas).
28. Integrasi: tulis REST tetap berhasil saat Supabase mati.
29. Integrasi: tulis tersimpan di file lokal.
(Butir 1 dan 4 masing-masing mencakup dua pemeriksaan, jadi totalnya
31 pemeriksaan.)

Catatan: pada kasus "baris Supabase kosong", yang di-seed adalah state
lokal — yang kalau belum ada dibuat dari `data/seed.json`. Jadi di
fresh install hasilnya sama persis dengan seed, tapi kalau server sudah
pernah jalan dari file lokal sebelum Supabase dipasang, data lokal yang
lebih baru tidak hilang.

## Yang sempat gagal saat pengembangan (dan perbaikannya)

- **Tes salah baca bentuk error SDK (bukan bug server).** SDK MCP
  mengembalikan pelanggaran tool sebagai hasil `{ isError: true }`,
  bukan throw; dan kunci salah melempar error dengan `code: 401`
  (bukan "401" di pesan). Skrip tes diperbaiki untuk memeriksa keduanya.
- **Server tes nyasar.** `process.exit()` di dalam `try` membuat
  `finally` tidak jalan, jadi server tes lama tetap hidup di port 3457
  dan mengotori run berikutnya (state seed ikut termutasi). Diperbaiki:
  tes sekarang memakai `process.exitCode` dan mematikan server di
  `finally`. Pelajaran: jangan `process.exit()` sebelum cleanup.
