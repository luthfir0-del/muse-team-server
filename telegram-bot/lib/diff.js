// lib/diff.js — cari peristiwa BARU dari satu snapshot GET /api/state.
//
// Jalur keluar utama bot adalah PUSH (server memanggil POST /api/notify
// tiap ada peristiwa baru — instan, lihat docs/server-push-patch.md).
// Poll berkala adalah CADANGANNYA: function serverless Vercel tidak
// menyimpan state antar request, jadi poll memakai JENDELA WAKTU: semua
// pesan + entri log aktivitas yang `time`-nya masuk jendela (sejak X menit
// lalu) dianggap baru. Push dan poll berbagi SATU cursor persisten per tim
// (lib/cursor.js, tabel telegram_poll_state) supaya satu peristiwa tidak
// diteruskan dua kali.
//
// Konsekuensi jujur: kalau satu run poll gagal/terlewat, peristiwa di luar
// jendela tidak diteruskan; kalau dua run tumpang tindih TANPA cursor
// (mis. Supabase belum dikonfigurasi di mode Vercel), satu peristiwa bisa
// diteruskan dua kali. MAX_EVENTS_PER_RUN membatasi banjir kalau bot
// sempat mati lama.
//
// Yang diteruskan:
//   - messages: pesan baru di ruang tim / DM (kecuali relay EL sendiri,
//     dikenali dari prefix EL_PREFIX — kalau tidak difilter, pesan EL
//     akan memantul balik ke Telegram EL).
//   - activity: entri log aktivitas baru (update status, tambah/ubah tugas).
//     Entri "mengirim pesan" dilewati — teks pesannya sudah diteruskan
//     lewat kanal messages, jadi meneruskan log-nya hanya duplikat.

import { BOT_PREFIX, EL_PREFIX } from "./config.js";

// Kunci unik satu peristiwa — dipakai dedup cursor (lib/cursor.js) supaya
// satu peristiwa tidak diteruskan dua kali (poll 10 detik + push).
// Pesan: id server (unik). Aktivitas: tanpa id — gabungan agent + teks +
// waktu (cukup unik di skala ini).
export function eventKey(ev) {
  if (ev.kind === "message") {
    return `m:${ev.id || `${ev.from}:${ev.text}:${ev.time}`}`;
  }
  return `a:${ev.agent}:${ev.event}:${ev.time}`;
}

// Kembalikan daftar peristiwa baru, urut kronologis (paling lama dulu).
// `sinceMs`: epoch ms — peristiwa dengan time >= sinceMs dianggap baru.
// `botFromAgent`: id agent yang dipakai bot (mis. "ell").
export function newEventsSince(state, sinceMs, { botFromAgent } = {}) {
  const events = [];

  for (const m of state.messages || []) {
    const t = Date.parse(m.time);
    if (Number.isNaN(t) || t < sinceMs) continue;
    // Relay EL sendiri dan pesan sistem bot — jangan dipantulkan balik
    // ke Telegram (kalau tidak difilter, pesan EL/bot akan memantul).
    if (typeof m.text === "string" && (m.text.startsWith(EL_PREFIX) || m.text.startsWith(BOT_PREFIX))) continue;
    events.push({ kind: "message", time: t, from: m.from, to: m.to, text: m.text, id: m.id });
  }

  for (const a of state.activity || []) {
    const t = Date.parse(a.time);
    if (Number.isNaN(t) || t < sinceMs) continue;
    if (typeof a.event === "string" && a.event.includes("mengirim pesan")) continue;
    events.push({ kind: "activity", time: t, agent: a.agent, event: a.event });
  }

  events.sort((x, y) => x.time - y.time);
  return events;
}

// Anomali dari snapshot saat ini (bukan perubahan — tanpa kursor persisten,
// bot v1 tidak bisa membedakan "baru jadi anomali" dari "sudah lama anomali").
// Dipakai sebagai lampiran saat ada peristiwa baru lain, BUKAN sebagai
// notifikasi berdiri sendiri (supaya tidak spam tiap run poll).
export function findAnomalies(state) {
  const out = [];
  for (const a of state.agents || []) {
    if (a.status && a.status !== "connected") {
      out.push(`⚠️ ${a.name} belum terhubung (status: ${a.status})`);
    }
  }
  const blocked = (state.tasks || []).filter((t) => t.status === "blocked");
  for (const t of blocked) {
    out.push(`🚫 Tugas macet: ${t.title} (${t.agent})`);
  }
  return out;
}
