// lib/notify.js — verifikasi + normalisasi endpoint push (POST /api/notify).
// Server tim menandatangani tiap push dengan HMAC-SHA256 memakai secret
// yang sama di kedua sisi (BOT_NOTIFY_SECRET) — lihat
// docs/server-push-patch.md. Fungsi di sini murni (gampang dites);
// wiring HTTP-nya ada di api/notify.js.

import { createHmac, timingSafeEqual } from "node:crypto";
import { BOT_PREFIX, EL_PREFIX } from "./config.js";

export function signPushPayload(secret, rawBody) {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

// Bandingkan signature header dengan yang dihitung — perbandingan waktu
// konstan supaya tidak bocor lewat timing. Header/panjang yang tidak
// cocok -> false (bukan throw).
export function verifyPushSignature(secret, rawBody, header) {
  if (!secret || typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const expected = Buffer.from(signPushPayload(secret, rawBody), "utf8");
  const got = Buffer.from(header, "utf8");
  if (got.length !== expected.length) return false;
  try {
    return timingSafeEqual(got, expected);
  } catch {
    return false;
  }
}

// Pesan relay EL / pesan sistem bot — jangan dipantulkan balik ke Telegram
// (kalau tidak difilter, pesan EL di ruang tim memantul ke chat EL sendiri).
export function isPushEcho(text) {
  return typeof text === "string" && (text.startsWith(EL_PREFIX) || text.startsWith(BOT_PREFIX));
}

// Normalisasi satu peristiwa push ke bentuk yang dipakai poll
// (lib/diff.js: time = epoch ms, kind "message"/"activity").
// Kembalikan null kalau bentuknya tidak sah.
export function normalizePushEvent(type, event) {
  if (!event || typeof event !== "object") return null;
  const time = typeof event.time === "number" ? event.time : Date.parse(event.time);
  if (Number.isNaN(time)) return null;
  if (type === "message" || event.kind === "message") {
    if (event.kind !== "message" || typeof event.from !== "string" || typeof event.text !== "string") return null;
    return { kind: "message", id: event.id || null, time, from: event.from, to: event.to || "team", text: event.text };
  }
  if (type === "activity" || event.kind === "activity") {
    if (event.kind !== "activity" || typeof event.agent !== "string" || typeof event.event !== "string") return null;
    return { kind: "activity", time, agent: event.agent, event: event.event };
  }
  return null;
}
