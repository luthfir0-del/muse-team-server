// api/notify.js — endpoint push instan dari server tim (POST /api/notify).
// Server memanggil endpoint ini SETIAP ada pesan/status/tugas baru
// (lihat muse-team-server/notify-bot.js + telegram-bot/docs/server-push-patch.md).
// Jauh lebih cepat dari poll: pesan sampai ke Telegram dalam hitungan
// detik, tanpa menunggu cron 1 menit. Poll tetap jalan sebagai cadangan —
// push dan poll berbagi SATU cursor per tim (lib/cursor.js), jadi satu
// peristiwa tidak pernah diteruskan dua kali.
//
// Keamanan: tiap push ditandatangani HMAC-SHA256 (header X-Bot-Signature)
// dengan BOT_NOTIFY_SECRET yang sama di kedua sisi. Tanpa secret yang
// benar: 401. Tanpa secret yang di-set di bot: 500 (push belum dikonfigurasi).
//
// Syarat: bot HARUS punya URL publik (deploy Vercel) supaya server bisa
// memanggilnya — mode lokal (local-bot.mjs) tidak bisa menerima push.

import { config } from "../lib/config.js";
import { createRegistry } from "../lib/registry.js";
import { sendTelegram } from "../lib/telegram.js";
import { advanceCursor, createCursorStore } from "../lib/cursor.js";
import { eventKey } from "../lib/diff.js";
import { formatEventForTeam } from "../lib/format.js";
import { isPushEcho, normalizePushEvent, verifyPushSignature } from "../lib/notify.js";

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function createNotifyHandler({ registry, sendTelegram, cursorStore, botNotifySecret }) {
  return async function handler(req, res) {
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, error: "Hanya POST." });
      return;
    }
    if (!botNotifySecret) {
      res.status(500).json({ ok: false, error: "BOT_NOTIFY_SECRET belum di-set — push belum dikonfigurasi." });
      return;
    }

    let raw;
    try {
      raw = await readRawBody(req);
    } catch {
      res.status(400).json({ ok: false, error: "Body tidak bisa dibaca." });
      return;
    }
    if (!verifyPushSignature(botNotifySecret, raw, req.headers["x-bot-signature"])) {
      res.status(401).json({ ok: false, error: "Signature tidak cocok." });
      return;
    }

    let body;
    try {
      body = JSON.parse(raw.toString("utf8") || "{}");
    } catch {
      res.status(400).json({ ok: false, error: "Body bukan JSON." });
      return;
    }
    if (typeof body.teamId !== "string" || !body.teamId) {
      res.status(400).json({ ok: false, error: "teamId wajib." });
      return;
    }
    const event = normalizePushEvent(body.type, body.event);
    if (!event) {
      res.status(400).json({ ok: false, error: "event tidak sah." });
      return;
    }

    const team = await registry.getTeam(body.teamId);
    if (!team || team.status !== "active") {
      res.status(404).json({ ok: false, error: "Tim tidak dikenal / tidak aktif." });
      return;
    }
    if (event.kind === "message" && isPushEcho(event.text)) {
      res.status(200).json({ ok: true, forwarded: 0, reason: "echo" });
      return;
    }

    // Dedup vs cursor yang sama dengan poll: peristiwa yang sudah
    // diteruskan (oleh push ini sendiri atau oleh poll) tidak dikirim lagi.
    let cursor = null;
    try {
      cursor = await cursorStore.load(team.id);
    } catch (e) {
      console.error("[notify] gagal baca cursor:", e.message);
    }
    const key = eventKey(event);
    const lastMs = cursor?.lastEventMs || 0;
    const seen = new Set(cursor?.seenKeys || []);
    if (event.time < lastMs || (event.time === lastMs && seen.has(key))) {
      res.status(200).json({ ok: true, forwarded: 0, deduped: true });
      return;
    }

    if (!team.notifyChatId) {
      // Tim terdaftar tapi belum ada chat notifikasi — jangan simpan cursor,
      // supaya poll cadangan masih bisa meneruskannya nanti.
      res.status(200).json({ ok: true, forwarded: 0, reason: "no-notify-chat" });
      return;
    }

    try {
      await sendTelegram(team.notifyChatId, formatEventForTeam(event, team));
    } catch (e) {
      console.error("[notify] gagal kirim ke Telegram:", e.message);
      res.status(502).json({ ok: false, error: "Gagal kirim ke Telegram." });
      return;
    }
    try {
      await cursorStore.save(team.id, advanceCursor(cursor, [event]));
    } catch (e) {
      console.error("[notify] gagal simpan cursor:", e.message);
    }
    res.status(200).json({ ok: true, forwarded: 1 });
  };
}

export default async function handler(req, res) {
  const registry = createRegistry({ cfg: config });
  return createNotifyHandler({
    registry,
    sendTelegram,
    cursorStore: createCursorStore(config),
    botNotifySecret: config.botNotifySecret,
  })(req, res);
}
