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

// Kirim pesan teks ke satu chat. Pakai parse_mode HTML (sudah di-escape
// oleh pemanggil lewat escapeHtml di lib/format.js).
export async function sendTelegram(chatId, text) {
  return callApi("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
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
