// api/poll.js — endpoint polling outbound (GET /api/poll).
// Dipanggil TIAP 1 MENIT dari luar (pemicu utama real-time — lihat README):
// cron 1 menit di VM memanggil URL ini (pola yang sama dengan cron
// sinkronisasi Ell tiap 1 menit). Cadangan: UptimeRobot tiap 5 menit atau
// Vercel Schedules 15-menitan. Bukan Vercel Cron (Hobby maks 1×/hari).
// Tiap run: untuk TIAP tim aktif, baca GET /api/state tim itu, cari
// peristiwa baru dalam jendela waktu (POLL_WINDOW_MINUTES), teruskan
// sebagai SATU pesan ringkasan ke chat notifikasi tim itu. Isolasi penuh:
// peristiwa tim A tidak pernah dikirim ke chat tim B. Kalau tidak ada
// yang baru di sebuah tim: diam untuk tim itu (tidak kirim apa-apa).
// Pengaman: butuh POLL_SECRET — lewat header `Authorization: Bearer ...`
// atau query `?key=...`. Tanpa secret yang benar: 401.
// Query opsional `?team=<id>` — hanya poll tim itu (untuk debug).

import { config } from "../lib/config.js";
import { createRegistry } from "../lib/registry.js";
import { fetchState } from "../lib/teamApi.js";
import { sendTelegram } from "../lib/telegram.js";
import { createCursorStore } from "../lib/cursor.js";
import { pollAllTeams } from "../lib/pollTeams.js";

function authorized(req) {
  if (!config.pollSecret) return false;
  const auth = req.headers.authorization || "";
  if (auth === `Bearer ${config.pollSecret}`) return true;
  const url = new URL(req.url, "http://localhost");
  return url.searchParams.get("key") === config.pollSecret;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "Hanya GET." });
    return;
  }
  if (!authorized(req)) {
    res.status(401).json({ ok: false, error: "POLL_SECRET tidak cocok." });
    return;
  }

  const url = new URL(req.url, "http://localhost");
  const teamFilter = url.searchParams.get("team") || null;

  try {
    const registry = createRegistry({ cfg: config });
    const results = await pollAllTeams({
      registry,
      fetchState,
      sendTelegram,
      pollWindowMinutes: config.pollWindowMinutes,
      maxEventsPerRun: config.maxEventsPerRun,
      teamFilter,
      // Cursor persisten (Supabase kalau dikonfigurasi) supaya poll tidak
      // meneruskan ulang peristiwa yang sudah didorong push (/api/notify).
      // Tanpa Supabase, store memori per-request: dedup antar invokasi
      // tidak jalan — jadi Supabase WAJIB untuk mode Vercel + push.
      cursorStore: createCursorStore(config),
    });
    const forwarded = results.reduce((n, r) => n + (r.forwarded || 0), 0);
    res.status(200).json({ ok: true, forwarded, teams: results });
  } catch (e) {
    console.error("[poll] gagal:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
}
