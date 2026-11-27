// lib/telegram.js — klien minimal Bot API Telegram (tanpa dependensi).
// Hanya memakai fetch bawaan Node 18+. Token TIDAK PERNAH ditulis ke log.
//
// ATURAN TOKEN (terverifikasi 27 Nov 2026): token disisipkan MENTAH ke
// path URL (`/bot<token>/METHOD`) — JANGAN pernah di-encode
// (encodeURIComponent mengubah `hsurr:` jadi `hsurr%3A`, egress tidak
// menukar surrogate, Telegram menjawab 404). Di Vercel, token berasal
// dari env TELEGRAM_BOT_TOKEN (deployer menempelkannya dari BotFather —
// salinan token di Secure Vault custom.telegram TIDAK BISA dibaca balik,
// jadi ambil dari BotFather lagi saat deploy Vercel). Di VM ini, semua
// panggilan lokal HARUS lewat helper ~/workspace/custom-connectors/
// custom.telegram/bin/tg.py (surrogate dinamis, token tidak pernah ada
// di file/env) — lihat scripts/tg-bridge.mjs. Bot terverifikasi:
// @SosmedTimbot ("My muse Tim", id 9275764510).

import { config } from "./config.js";

function apiUrl(method) {
  if (!config.botToken) throw new Error("TELEGRAM_BOT_TOKEN belum di-set.");
  // Token mentah di path — JANGAN encodeURIComponent (lihat catatan atas).
  return `https://api.telegram.org/bot${config.botToken}/${method}`;
}

async function callApi(method, payload) {
  const res = await fetch(apiUrl(method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(`Telegram API ${method} gagal: HTTP ${res.status} ${data.description || ""}`.trim());
  }
  return data.result;
}

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Batas teks satu pesan Telegram: 4096 karakter. Digest poll bisa jauh
// lebih panjang — satu update status Mas saja 3.800-4.800 karakter
// (terbukti 5x gagal 28 Nov 2026 dengan "message is too long").
// Potong per baris supaya tag HTML formatter (<b>/<i>/<code>, yang
// selalu seimbang dalam satu baris) tidak terbelah; baris tunggal yang
// lebih panjang dari batas dipotong keras.
export const MAX_TELEGRAM_TEXT = 4000;

export function splitLongText(text, max = MAX_TELEGRAM_TEXT) {
  const s = String(text ?? "");
  if (s.length <= max) return [s];
  const chunks = [];
  let rest = s;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < 1) cut = max; // tidak ada baris sebelum batas: potong keras
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

// Kirim pesan teks ke satu chat. Pakai parse_mode HTML (sudah di-escape
// oleh pemanggil lewat escapeHtml di lib/format.js).
// Pesan panjang dipecah jadi beberapa pesan berurutan supaya tidak
// ditolak Telegram (batas 4096 karakter).
export async function sendTelegram(chatId, text) {
  const parts = splitLongText(text);
  let last = null;
  for (let i = 0; i < parts.length; i++) {
    const part = i < parts.length - 1 ? `${parts[i]}\n<i>(bersambung…)</i>` : parts[i];
    last = await callApi("sendMessage", {
      chat_id: chatId,
      text: part,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  }
  return last;
}

// Hapus satu pesan (dipakai untuk menghapus pesan /gabung yang berisi
// kunci agent — best-effort, pemanggil mengabaikan kegagalan).
export async function deleteTelegramMessage(chatId, messageId) {
  return callApi("deleteMessage", {
    chat_id: chatId,
    message_id: messageId,
  });
}

// Ambil update masuk (dipakai mode long-polling lokal, scripts/dev-poll.mjs).
export async function getUpdates(offset, timeoutSeconds = 25) {
  return callApi("getUpdates", { offset, timeout: timeoutSeconds });
}

// Pasang webhook (dipakai sekali saat deploy, scripts/set-webhook.mjs).
export async function setWebhook(url, secretToken) {
  return callApi("setWebhook", {
    url,
    secret_token: secretToken || undefined,
    drop_pending_updates: true,
  });
}
