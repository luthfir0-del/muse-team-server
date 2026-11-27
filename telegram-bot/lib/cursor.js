// lib/cursor.js — kursor poll per tim (dedup).
//
// Masalah yang dipecahkan: poll 10 detik dengan jendela 2 menit melihat
// satu peristiwa ~12×. Tanpa dedup, tiap peristiwa terkirim berkali-kali.
// Cursor menyimpan, per tim, peristiwa terakhir yang SUDAH diteruskan:
//   { lastEventMs, seenKeys }
//   - lastEventMs: epoch ms peristiwa terbaru yang diteruskan.
//   - seenKeys: kunci peristiwa (lihat eventKey di lib/diff.js) yang
//     diteruskan tepat pada lastEventMs (menangani beberapa peristiwa
//     dalam milidetik yang sama).
// Aturan saring: teruskan peristiwa dengan time > lastEventMs, ATAU
// time == lastEventMs dan kuncinya belum ada di seenKeys.
//
// Dua backend (antarmuka sama: load(teamId), save(teamId, cursor)):
//   - Memori (proses) — untuk runner lokal tanpa Supabase dan untuk tes.
//     Hilang saat proses restart (poll berikutnya mungkin menduplikat
//     satu jendela — diterima, lihat README).
//   - Supabase (tabel telegram_poll_state) — persisten antar restart dan
//     antar invokasi serverless. WAJIB untuk rute poll-loop 10 detik yang
//     memanggil /api/poll (tiap invokasi proses baru). Dibuat lewat
//     createCursorStore(cfg) — memakai Supabase kalau dikonfigurasi,
//     kalau tidak memakai memori.

import { createSupabaseRegistryClient } from "./registry.js";
import { eventKey } from "./diff.js";

// Saring peristiwa yang BELUM diteruskan menurut cursor.
// cursor: { lastEventMs, seenKeys } | null (null = belum ada cursor).
// Teruskan peristiwa dengan time > lastEventMs, ATAU time == lastEventMs
// dan kuncinya belum ada di seenKeys.
export function filterFreshEvents(events, cursor) {
  if (!cursor) return [...events];
  const seen = new Set(cursor.seenKeys || []);
  return events.filter(
    (ev) => ev.time > cursor.lastEventMs || (ev.time === cursor.lastEventMs && !seen.has(eventKey(ev)))
  );
}

// Maju cursor setelah peristiwa-peristiwa berhasil diteruskan.
// Hanya kunci peristiwa pada milidetik terbaru yang disimpan (menangani
// beberapa peristiwa dalam milidetik yang sama); peristiwa yang lebih
// lama dari itu tidak akan diteruskan lagi (dipotong lastEventMs).
export function advanceCursor(cursor, forwarded) {
  if (!forwarded.length) return cursor || { lastEventMs: 0, seenKeys: [] };
  const maxTime = Math.max(...forwarded.map((e) => e.time));
  const prev = cursor || { lastEventMs: 0, seenKeys: [] };
  const kept = maxTime === prev.lastEventMs ? [...(prev.seenKeys || [])] : [];
  for (const ev of forwarded) if (ev.time === maxTime) kept.push(eventKey(ev));
  return { lastEventMs: maxTime, seenKeys: kept };
}

export function createMemoryCursorStore() {
  const map = new Map();
  return {
    async load(teamId) {
      return map.get(teamId) || null;
    },
    async save(teamId, cursor) {
      map.set(teamId, { lastEventMs: cursor.lastEventMs, seenKeys: [...(cursor.seenKeys || [])] });
    },
  };
}

export function createSupabaseCursorStore(client) {
  return {
    async load(teamId) {
      const row = await client.getPollState(teamId);
      if (!row) return null;
      return { lastEventMs: row.lastEventMs || 0, seenKeys: row.seenKeys || [] };
    },
    async save(teamId, cursor) {
      await client.setPollState(teamId, {
        lastEventMs: cursor.lastEventMs,
        seenKeys: [...(cursor.seenKeys || [])],
      });
    },
  };
}

// Pilih backend: Supabase kalau dikonfigurasi, kalau tidak memori.
// `supabase` boleh di-inject (tes); kalau undefined, dibangun dari cfg.
export function createCursorStore(cfg, supabase = undefined) {
  const client =
    supabase !== undefined
      ? supabase
      : createSupabaseRegistryClient({ url: cfg.supabaseUrl, serviceKey: cfg.supabaseServiceKey });
  if (!client) return createMemoryCursorStore();
  return createSupabaseCursorStore(client);
}
