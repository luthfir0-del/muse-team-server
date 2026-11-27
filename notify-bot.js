// notify-bot.js — push instan ke bot Telegram (POST /api/notify).
//
// Server memanggil bot SETIAP ada pesan/status/tugas baru, supaya pemilik
// melihatnya di Telegram dalam hitungan detik — tanpa menunggu poll.
// Dipakai server.js di akhir tiap fungsi mutasi (doSendMessage,
// doUpdateStatus, doUpsertTask, doSetTaskStatus).
//
// Cara kerja:
//   POST <BOT_NOTIFY_URL>  (mis. https://<domain-bot>/api/notify)
//   Body: { teamId, type: "message" | "activity", event: {...} }
//   Header: X-Bot-Signature: sha256=<HMAC-SHA256(secret, body)>
//   Timeout: BOT_NOTIFY_TIMEOUT_MS (default 1500 ms).
//
// Env (server):
//   BOT_NOTIFY_URL     — URL endpoint /api/notify di deployment bot
//                        (WAJIB punya URL publik — bot harus di-deploy
//                        di Vercel; mode lokal tidak bisa menerima push).
//   BOT_NOTIFY_SECRET  — secret HMAC; NILAI YANG SAMA harus di-set di bot.
//   TEAM_ID            — id tim server ini di registry bot (mis. "raden").
//   BOT_NOTIFY_TIMEOUT_MS — opsional, default 1500.
//
// Kalau bot DOWN (timeout / koneksi gagal / HTTP bukan 2xx):
//   -> DILEWATI + dicatat di log (console.warn). TIDAK ada antrean dan
//      TIDAK ada retry. Alasannya: poll 1 menit adalah cadangan yang akan
//      meneruskan peristiwa itu (cursor yang sama mencegah duplikat), jadi
//      antrean hanya menambah kerumitan + risiko banjir duplikat.
//      Push tidak pernah menggagalkan mutasi: notify() TIDAK PERNAH throw.
//
// Kalau push TIDAK dikonfigurasi (URL/secret kosong): notifier non-aktif,
// server jalan seperti biasa (poll saja). Jadi patch ini aman di-deploy
// sebelum bot siap — push mulai jalan begitu env di-set + server restart.

import { createHmac } from "node:crypto";

export const DEFAULT_TIMEOUT_MS = 1500;

// Prefix yang dipakai bot untuk pesan relay EL / pesan sistemnya sendiri
// (telegram-bot/lib/config.js: EL_PREFIX, BOT_PREFIX). Pesan dengan prefix
// ini TIDAK didorong balik ke Telegram (anti-pantul).
export const EL_PREFIX = "[EL] ";
export const BOT_PREFIX = "[Bot] ";

export function signPayload(secret, rawBody) {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

// Pesan relay EL / sistem bot — jangan didorong balik ke Telegram.
export function isEchoMessage(text) {
  return typeof text === "string" && (text.startsWith(EL_PREFIX) || text.startsWith(BOT_PREFIX));
}

// Bentuk peristiwa push = bentuk peristiwa poll (telegram-bot/lib/diff.js):
// time = epoch ms (bukan ISO) supaya kursor dedup push-vs-poll cocok.
export function messageEvent(msg) {
  return {
    kind: "message",
    id: msg.id,
    time: Date.parse(msg.time),
    from: msg.from,
    to: msg.to,
    text: msg.text,
  };
}

export function activityEvent(entry) {
  return { kind: "activity", time: Date.parse(entry.time), agent: entry.agent, event: entry.event };
}

export function createNotifier({
  url = "",
  secret = "",
  teamId = "raden",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  const enabled = Boolean(url && secret);

  // Kirim satu push. TIDAK PERNAH throw — semua kegagalan dikembalikan
  // sebagai { ok: false, reason } dan dicatat, supaya mutasi server
  // tidak pernah gagal gara-gara bot.
  async function notify({ type, event }) {
    if (!enabled) return { ok: false, reason: "disabled" };
    const payload = JSON.stringify({ teamId, type, event });
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Bot-Signature": signPayload(secret, payload),
        },
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        console.warn(`[notify-bot] push ${type} ditolak bot (HTTP ${res.status}) — dilewati, poll cadangan akan meneruskan.`);
        return { ok: false, reason: `http-${res.status}` };
      }
      return { ok: true, status: res.status };
    } catch (e) {
      console.warn(`[notify-bot] push ${type} gagal (${e.message}) — dilewati, poll cadangan akan meneruskan.`);
      return { ok: false, reason: e.message };
    }
  }

  return { enabled, notify };
}
