// scripts/set-webhook.mjs — pasang webhook Telegram (mode Vercel).
//   node scripts/set-webhook.mjs https://<domain-bot-vercel>/api/webhook
// Memakai helper tg.py (konektor custom.telegram) — TIDAK BUTUH token di
// env. Men-drop pending update supaya pesan lama tidak membanjiri bot
// saat pertama jalan. Cek hasilnya dengan membuka /api/health di browser
// atau `tg.py webhookinfo`.
// Catatan: webhook dan long-polling saling meniadakan — pasang webhook
// hanya kalau bot jalan di Vercel; untuk runner lokal (local-bot.mjs),
// hapus webhook dulu (`tg.py deletewebhook`).

import { tgSetWebhook } from "./tg-bridge.mjs";

const url = process.argv[2];
if (!url || !url.startsWith("https://")) {
  console.error("Pakai: node scripts/set-webhook.mjs https://<domain-bot>/api/webhook");
  process.exit(1);
}

const secret = process.env.TELEGRAM_WEBHOOK_SECRET || undefined;
const result = tgSetWebhook(url, secret);
console.log("Webhook terpasang:", JSON.stringify(result));
