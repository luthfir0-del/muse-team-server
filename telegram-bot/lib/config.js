// lib/config.js — baca env var. TIDAK PERNAH mencetak nilai kunci/token ke
// log, respons, atau file. Yang boleh di-log hanya ADA/TIDAKNYA sebuah var.
//
// v2 (multi-tim): satu bot melayani BANYAK tim. Tiap tim punya server,
// kunci agent, dan chat Telegram sendiri — lihat lib/registry.js.
// Konfigurasi tim ada DUA sumber:
//   1. TEAMS_JSON (statis, di env) — daftar tim yang dikenal sejak deploy.
//      Kalau kosong, tim utama v1 dibangun dari env lama (TEAM_SERVER_URL
//      + TEAM_API_KEY + BOT_FROM_AGENT_ID) sebagai tim "raden".
//   2. Supabase (dinamis) — tim yang gabung lewat perintah /gabung.
//      Butuh SUPABASE_URL + SUPABASE_SERVICE_KEY (nilai yang sama dengan
//      project Vercel server tim). Tanpa ini, /gabung tidak bisa dipakai
//      (registry hanya-statis; tambah tim = ubah TEAMS_JSON + redeploy).

export function env(name, fallback = undefined) {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export function requiredEnv(name) {
  const v = env(name);
  if (!v) throw new Error(`Env var ${name} belum di-set.`);
  return v;
}

export const config = {
  // Token bot Telegram dari @BotFather. Hanya dari env — tidak pernah di kode.
  botToken: env("TELEGRAM_BOT_TOKEN", ""),
  // Chat id Telegram SUPER-OWNER (EL) — bisa melihat + memerintah SEMUA tim.
  ownerChatId: env("OWNER_CHAT_ID", ""),
  // Secret validasi webhook Telegram (header X-Telegram-Bot-Api-Secret-Token).
  webhookSecret: env("TELEGRAM_WEBHOOK_SECRET", ""),
  // Secret pengaman endpoint /api/poll (header Bearer atau ?key=).
  pollSecret: env("POLL_SECRET", ""),
  // Secret HMAC untuk endpoint push POST /api/notify (server tim
  // menandatangani tiap push dengan secret yang SAMA — lihat
  // docs/server-push-patch.md). Tanpa ini, push ditolak (500).
  botNotifySecret: env("BOT_NOTIFY_SECRET", ""),
  // Jendela peristiwa baru (menit) yang diteruskan tiap run poll.
  // Aturan: jendela = interval pemicu + 1 menit (supaya cold start tidak
  // membuat peristiwa terlewat). Pemicu utama adalah cron 1 menit (lihat
  // README soal real-time) -> jendela default 2 menit. Kalau pemicu utama
  // UptimeRobot 5-menitan, set jadi 7.
  pollWindowMinutes: Number(env("POLL_WINDOW_MINUTES", "2")) || 2,
  // Batas peristiwa per satu run poll PER TIM (anti-spam kalau bot sempat mati lama).
  maxEventsPerRun: Number(env("MAX_EVENTS_PER_RUN", "10")) || 10,

  // ---- Registry tim (v2) ----
  // JSON array tim statis, mis:
  //   [{"id":"raden","name":"Tim Raden","serverUrl":"https://...","apiKey":"...",
  //     "fromAgent":"ell","agents":["mas","mbak","ell"],"ownerChatId":"123","notifyChatId":"123"}]
  teamsJson: env("TEAMS_JSON", ""),
  // Tim utama v1 (dipakai kalau TEAMS_JSON kosong).
  teamServerUrl: (env("TEAM_SERVER_URL", "https://muse-team-server.vercel.app") || "").replace(/\/+$/, ""),
  botApiKey: env("TEAM_API_KEY", ""),
  botFromAgent: env("BOT_FROM_AGENT_ID", "ell"),
  // Tim aktif default di chat super-owner (id tim, mis. "raden").
  defaultTeamId: env("DEFAULT_TEAM_ID", ""),
  // Kalau "true": tim yang gabung lewat /gabung berstatus "pending" dan
  // harus disetujui EL (/setuju <id>) sebelum aktif.
  requireElApproval: env("REQUIRE_EL_APPROVAL", "false") === "true",
  // Supabase untuk registry dinamis (tim gabung runtime). Nilai yang sama
  // dengan env project Vercel server tim. Tanpa keduanya: mode statis saja.
  supabaseUrl: env("SUPABASE_URL", ""),
  supabaseServiceKey: env("SUPABASE_SERVICE_KEY", ""),
};

// Prefix penanda pesan dari EL di ruang tim, supaya tim tahu itu
// perintah/pesan pemilik, bukan pesan agent pengirim.
export const EL_PREFIX = "[EL] ";

// Prefix pesan sistem dari BOT sendiri (mis. jabat tangan saat /gabung).
// Poller tidak pernah meneruskan pesan ber-prefix ini balik ke Telegram.
export const BOT_PREFIX = "[Bot] ";

// Id agent yang sah di server tim v1 (dipakai sebagai daftar default;
// tiap tim bisa punya daftar sendiri di registry — lihat lib/registry.js).
export const AGENT_IDS = ["mas", "mbak", "ell"];
export const AGENT_NAMES = { mas: "Mas", mbak: "Mbak", ell: "Ell" };

// Bentuk satu tim di registry. `apiKey` adalah RAHASIA — tidak pernah
// ditulis ke log, respons Telegram, atau hasil fungsi "publik".
//   id:           slug unik, [a-z0-9-], maks 32 karakter
//   name:         nama tampil (mis. "Tim Raden")
//   serverUrl:    URL server tim (tanpa trailing slash)
//   apiKey:       kunci agent pengirim di server itu
//   fromAgent:    id agent yang dipakai kunci itu (dipelajari dari jabat
//                 tangan /gabung; default "ell" untuk tim statis)
//   agents:       id agent yang dikenal tim itu (validasi /dm)
//   ownerChatId:  chat Telegram pemilik tim (string angka; di grup: id user pengirim /gabung)
//   notifyChatId: chat tujuan notifikasi poll (default = ownerChatId; bisa grup)
//   status:       "active" | "pending" | "disabled"
//   source:       "static" (env) | "dynamic" (Supabase) — diisi registry
//   createdAt / createdBy: jejak pendaftaran (dynamic saja)
