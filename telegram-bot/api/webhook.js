// api/webhook.js — endpoint webhook Telegram (POST /api/webhook).
// Telegram memanggil endpoint ini setiap ada pesan masuk.
// Validasi: header X-Telegram-Bot-Api-Secret-Token harus sama dengan
// TELEGRAM_WEBHOOK_SECRET (kalau di-set). Routing tim (chat mana -> tim
// mana) dicek di lib/commands.js + lib/registry.js. Selalu balas 200
// secepatnya supaya Telegram tidak retry; kesalahan dicatat di log tanpa
// nilai rahasia. Balasan ke chat pengirim + notifikasi tambahan (mis. EL
// saat tim baru gabung) dikirim lewat lib/telegram.js.

import { config } from "../lib/config.js";
import { createRegistry } from "../lib/registry.js";
import { handleTelegramMessage } from "../lib/commands.js";
import { deleteTelegramMessage, sendTelegram } from "../lib/telegram.js";
import { fetchState, sendTeamMessage, verifyTeamConnection } from "../lib/teamApi.js";

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Hanya POST." });
    return;
  }

  if (config.webhookSecret) {
    const got = req.headers["x-telegram-bot-api-secret-token"];
    if (got !== config.webhookSecret) {
      res.status(401).json({ ok: false });
      return;
    }
  }

  let update;
  try {
    update = await readJson(req);
  } catch {
    res.status(400).json({ ok: false, error: "Body bukan JSON." });
    return;
  }

  const msg = update?.message;
  if (msg?.chat?.id) {
    try {
      const registry = createRegistry({ cfg: config });
      const action = await handleTelegramMessage(msg, {
        registry,
        fetchState,
        sendTeamMessage,
        verifyTeamConnection,
        deleteMessage: deleteTelegramMessage,
        ownerChatId: config.ownerChatId,
      });
      if (action.reply) await sendTelegram(msg.chat.id, action.reply);
      for (const n of action.notify || []) {
        try {
          await sendTelegram(n.chatId, n.text);
        } catch (e) {
          console.error("[webhook] gagal kirim notifikasi:", e.message);
        }
      }
    } catch (e) {
      // Jangan bocorkan isi error ke Telegram; cukup log pesannya saja.
      console.error("[webhook] gagal memproses pesan:", e.message);
    }
  }

  res.status(200).json({ ok: true });
}
