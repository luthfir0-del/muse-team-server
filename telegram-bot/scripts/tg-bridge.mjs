// scripts/tg-bridge.mjs — jembatan Node -> helper tg.py (konektor
// custom.telegram). SEMUA panggilan Bot API dari VM ini HARUS lewat sini.
//
// Pola kredensial (terverifikasi 27 Nov 2026): tg.py mengambil surrogate
// dinamis dari Secure Vault (dynamic_credential_entry) dan menyisipkannya
// MENTAH ke path URL `https://api.telegram.org/bot<surrogate>/METHOD` —
// tanpa percent-quoting (yang meng-quote membuat egress gagal swap dan
// Telegram menjawab 404). Token TIDAK PERNAH ada di env, file, argumen,
// atau log proses ini — yang lewat sini hanya chat id + teks pesan.
//
// Dipakai runner lokal (local-bot.mjs) dan set-webhook.mjs. Bot
// terverifikasi: @SosmedTimbot ("My muse Tim", id 9275764510).

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export const TG_PY = join(
  homedir(),
  "workspace/custom-connectors/custom.telegram/bin/tg.py"
);

// Panggil satu subcommand tg.py, kembalikan `result` (atau lempar Error).
// `timeoutMs` harus lebih besar dari timeout long-polling getUpdates.
export function tgCall(cmd, args = [], { timeoutMs = 30000 } = {}) {
  let out;
  try {
    out = execFileSync("python3", [TG_PY, cmd, ...args], {
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const stderr = (e.stderr || e.message || "").toString().slice(0, 300);
    throw new Error(`tg.py ${cmd} gagal: ${stderr}`);
  }
  let data;
  try {
    data = JSON.parse(out);
  } catch {
    throw new Error(`tg.py ${cmd}: jawaban bukan JSON.`);
  }
  if (!data.ok) {
    throw new Error(`Telegram ${cmd} gagal: ${data.description || JSON.stringify(data).slice(0, 200)}`);
  }
  return data.result;
}

export function tgGetMe() {
  return tgCall("getme");
}

export function tgSend(chatId, text) {
  return tgCall("send", ["--chat-id", String(chatId), "--text", text]);
}

export function tgGetUpdates(offset, timeoutSeconds = 25) {
  const args = [];
  if (offset !== undefined && offset !== null) args.push("--offset", String(offset));
  if (timeoutSeconds) args.push("--timeout", String(timeoutSeconds));
  return tgCall("getupdates", args, { timeoutMs: (timeoutSeconds + 30) * 1000 });
}

export function tgSetWebhook(url, secret) {
  const args = ["--url", url];
  if (secret) args.push("--secret", secret);
  return tgCall("setwebhook", args);
}

export function tgDeleteWebhook() {
  return tgCall("deletewebhook");
}

export function tgWebhookInfo() {
  return tgCall("webhookinfo");
}

// Best-effort: hapus satu pesan (mis. /gabung yang berisi kunci).
// Mengembalikan true kalau berhasil, false kalau gagal (pemanggil
// mengabaikan — pemilik tetap diminta menghapus manual).
export function tgDeleteMessage(chatId, messageId) {
  try {
    tgCall("deletemessage", ["--chat-id", String(chatId), "--message-id", String(messageId)]);
    return true;
  } catch {
    return false;
  }
}
