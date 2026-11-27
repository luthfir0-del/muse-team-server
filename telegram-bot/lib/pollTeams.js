// lib/pollTeams.js — logika poll outbound untuk SEMUA tim (dipakai
// endpoint HTTP api/poll.js DAN runner lokal scripts/local-bot.mjs).
//
// Satu run: untuk tiap tim aktif, baca GET /api/state tim itu, cari
// peristiwa baru dalam jendela waktu, kirim SATU digest ke chat notifikasi
// tim itu (notifyChatId). Isolasi penuh: peristiwa tim A tidak pernah
// dikirim ke chat tim B. Tiap digest diberi label nama tim, supaya EL
// yang memantau banyak tim tahu peristiwa ini dari tim mana.
//
// Poll adalah CADANGAN dari server push (POST /api/notify, lihat
// docs/server-push-patch.md): push yang terlewat (bot sempat down) tetap
// diteruskan poll dalam ~1 menit. Supaya push + poll tidak mengirim
// peristiwa yang sama dua kali, keduanya berbagi SATU cursor per tim
// (lib/cursor.js) — cursor hanya maju SETELAH kirim berhasil.
//
// `sendTelegram` di-inject (api/poll.js memakai lib/telegram.js,
// local-bot memakai scripts/tg-bridge.mjs) supaya gampang dites.

import { findAnomalies, newEventsSince } from "./diff.js";
import { formatEventForTeam } from "./format.js";
import { advanceCursor, createMemoryCursorStore, filterFreshEvents } from "./cursor.js";

export async function pollAllTeams({
  registry,
  fetchState,
  sendTelegram,
  pollWindowMinutes = 7,
  maxEventsPerRun = 10,
  teamFilter = null, // opsional: hanya poll tim ini (untuk debug)
  // Store cursor untuk dedup antar run (push vs poll). Kalau tidak
  // di-pass, dipakai store memori BARU per run — dedup hanya di dalam
  // satu run, bukan antar run. Pemanggil yang mau dedup antar run
  // (api/poll.js, local-bot) WAJIB mem-pass store-nya sendiri
  // (createCursorStore — Supabase kalau dikonfigurasi, memori kalau tidak).
  cursorStore = null,
} = {}) {
  const store = cursorStore || createMemoryCursorStore();
  const teams = (await registry.listTeams()).filter((t) => t.status === "active");
  const targets = teamFilter ? teams.filter((t) => t.id === teamFilter) : teams;
  const sinceMs = Date.now() - pollWindowMinutes * 60 * 1000;
  const results = [];

  for (const team of targets) {
    const result = { teamId: team.id, teamName: team.name, forwarded: 0 };
    try {
      const state = await fetchState(team);
      let events = newEventsSince(state, sinceMs);
      // Dedup vs cursor (peristiwa yang sudah didorong push tidak
      // diteruskan lagi oleh poll). Kalau baca cursor gagal, lanjut
      // dengan jendela saja (mungkin duplikat satu run — diterima).
      let cursor = null;
      try {
        cursor = await store.load(team.id);
      } catch (e) {
        console.warn(`[poll] gagal baca cursor tim ${team.id}:`, e.message);
      }
      events = filterFreshEvents(events, cursor).slice(0, maxEventsPerRun);
      if (!events.length) {
        results.push(result);
        continue;
      }
      const parts = events.map((ev) => formatEventForTeam(ev, team));
      const anomalies = findAnomalies(state);
      if (anomalies.length) {
        parts.push(`\n<b>Perlu perhatian:</b>\n${anomalies.join("\n")}`);
      }
      await sendTelegram(team.notifyChatId, parts.join("\n\n"));
      // Hitung forwarded HANYA setelah kirim berhasil — kalau kirim
      // gagal (mis. pesan terlalu panjang), log harus 0, bukan jumlah
      // peristiwa yang coba dikirim (bug log 28 Nov 2026: "forwarded 2"
      // padahal tidak ada yang sampai ke Telegram).
      result.forwarded = events.length;
      // Cursor maju HANYA setelah kirim berhasil — kalau kirim gagal,
      // run berikutnya mencoba lagi.
      try {
        await store.save(team.id, advanceCursor(cursor, events));
      } catch (e) {
        console.warn(`[poll] gagal simpan cursor tim ${team.id}:`, e.message);
      }
    } catch (e) {
      result.forwarded = 0;
      result.error = e.message;
    }
    results.push(result);
  }

  return results;
}
