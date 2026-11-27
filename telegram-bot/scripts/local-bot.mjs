// scripts/local-bot.mjs — runner LOKAL bot (mode yang disarankan).
//
// Menjalankan bot dari VM ini TANPA deploy Vercel dan TANPA token di env:
//   - MASUK (Telegram -> tim): long-polling getUpdates lewat tg.py
//     (konektor custom.telegram — token dari Secure Vault, tidak pernah
//     ada di proses ini), diproses lib/commands.js yang sama dengan webhook.
//   - KELUAR (tim -> Telegram): server MENDORONG lewat POST /api/notify
//     (instan, hitungan detik) kalau bot di-deploy di Vercel — lihat
//     docs/server-push-patch.md. Runner lokal ini TIDAK BISA menerima push
//     (tidak punya URL publik), jadi di mode lokal jalur keluarnya tetap
//     POLL tiap POLL_INTERVAL_MINUTES (default 1) — baca state semua tim
//     aktif, kirim digest ke chat notifikasi tiap tim. Poll juga jalan
//     sebagai CADANGAN push di mode Vercel (cron 1 menit -> /api/poll).
// Hentikan dengan Ctrl+C.
//
// Env yang dibaca: registry tim (TEAMS_JSON / SUPABASE_URL +
// SUPABASE_SERVICE_KEY), OWNER_CHAT_ID, POLL_WINDOW_MINUTES,
// MAX_EVENTS_PER_RUN, POLL_INTERVAL_MINUTES (default 1).
// TIDAK BUTUH: TELEGRAM_BOT_TOKEN, POLL_SECRET, TELEGRAM_WEBHOOK_SECRET,
// BOT_NOTIFY_SECRET (push hanya diterima endpoint Vercel /api/notify).
// Sebelum jalan pertama kali: pastikan tidak ada webhook aktif
// (tg.py deletewebhook) — webhook dan long-polling saling meniadakan.
// Bot terverifikasi: @SosmedTimbot ("My muse Tim").
//
// Catatan: proses ini mati kalau VM di-restart/diganti (seperti
// FreeLLMAPI) — jalankan ulang dengan perintah di bawah, atau jadikan
// cron/systemd. Mode Vercel (webhook) tetap tersedia, lihat README.

import { config } from "../lib/config.js";
import { createRegistry } from "../lib/registry.js";
import { handleTelegramMessage } from "../lib/commands.js";
import { fetchState, sendTeamMessage, verifyTeamConnection } from "../lib/teamApi.js";
import { pollAllTeams } from "../lib/pollTeams.js";
import { createCursorStore } from "../lib/cursor.js";
import { tgDeleteMessage, tgGetMe, tgGetUpdates, tgSend } from "./tg-bridge.mjs";

const POLL_INTERVAL_MINUTES = Number(process.env.POLL_INTERVAL_MINUTES || "1") || 1;

const me = tgGetMe();
console.log(`[local-bot] bot: @${me.username} (${me.first_name}). Long-polling jalan. Ctrl+C untuk berhenti.`);

const registry = createRegistry({ cfg: config });
// SATU cursor store untuk seluruh umur proses — dedup antar run poll
// (Supabase kalau dikonfigurasi, memori kalau tidak; restart proses
// dengan store memori mungkin menduplikat satu jendela — diterima).
const cursorStore = createCursorStore(config);

async function sendTelegram(chatId, text) {
  return tgSend(chatId, text);
}

async function runOutboundPoll() {
  try {
    const results = await pollAllTeams({
      registry,
      fetchState,
      sendTelegram,
      pollWindowMinutes: config.pollWindowMinutes,
      maxEventsPerRun: config.maxEventsPerRun,
      cursorStore,
    });
    const forwarded = results.reduce((n, r) => n + (r.forwarded || 0), 0);
    const errors = results.filter((r) => r.error).map((r) => `${r.teamId}: ${r.error}`);
    console.log(`[local-bot] poll: ${forwarded} peristiwa diteruskan ke ${results.length} tim.${errors.length ? ` Error: ${errors.join(" | ")}` : ""}`);
  } catch (e) {
    console.error("[local-bot] poll gagal:", e.message);
  }
}

// Poll outbound pertama langsung, lalu berkala.
await runOutboundPoll();
const pollTimer = setInterval(runOutboundPoll, POLL_INTERVAL_MINUTES * 60 * 1000);

let offset = 0;
let stopped = false;
process.on("SIGINT", () => {
  stopped = true;
  clearInterval(pollTimer);
  console.log("\n[local-bot] berhenti.");
});

while (!stopped) {
  let updates;
  try {
    updates = tgGetUpdates(offset, 25);
  } catch (e) {
    console.error("[local-bot] getUpdates gagal, coba lagi 5 dtk:", e.message);
    await new Promise((r) => setTimeout(r, 5000));
    continue;
  }
  for (const u of updates || []) {
    offset = u.update_id + 1;
    const msg = u.message;
    if (!msg?.chat?.id) continue;
    console.log(`[local-bot] pesan dari chat ${msg.chat.id}: ${(msg.text || "").slice(0, 60)}`);
    try {
      const action = await handleTelegramMessage(msg, {
        registry,
        fetchState,
        sendTeamMessage,
        verifyTeamConnection,
        deleteMessage: async (chatId, messageId) => {
          tgDeleteMessage(chatId, messageId);
        },
        ownerChatId: config.ownerChatId,
      });
      if (action.reply) await sendTelegram(msg.chat.id, action.reply);
      for (const n of action.notify || []) {
        try {
          await sendTelegram(n.chatId, n.text);
        } catch (e) {
          console.error("[local-bot] gagal kirim notifikasi:", e.message);
        }
      }
    } catch (e) {
      console.error("[local-bot] gagal memproses pesan:", e.message);
    }
  }
}
