// lib/teamApi.js — klien REST server tim (muse-team-server), PER TIM.
// Bentuk state mengikuti GET /api/state server (lihat server.js publicState):
//   { version, updated, agents[], tasks[], messages[], activity[] }
//   agent: { id, name, role, color, status, currentActivity, statusDetail,
//            connectedAt, tasksDone, tasksTotal }
//   task:  { id, agent, title, detail, time, status }
//   message: { id, from, to ("team" | id agent), text, time }
//   activity: { agent, event, time }
//
// GET /api/state + /health publik (tanpa auth). POST /api/messages butuh
// kunci agent tim itu (Bearer atau X-API-Key) — `from` diisi server dari
// kunci yang dipakai. Semua fungsi di sini menerima objek tim dari
// lib/registry.js, supaya satu bot bisa melayani banyak tim dengan kunci
// dan server yang berbeda-beda (isolasi antar tim).

import { BOT_PREFIX } from "./config.js";

export async function fetchState(team) {
  const res = await fetch(`${team.serverUrl}/api/state`);
  if (!res.ok) throw new Error(`GET /api/state ${team.id} gagal: HTTP ${res.status}`);
  return res.json();
}

export async function fetchHealth(team) {
  const res = await fetch(`${team.serverUrl}/health`);
  if (!res.ok) throw new Error(`GET /health ${team.id} gagal: HTTP ${res.status}`);
  return res.json();
}

// Kirim pesan ke ruang tim ("team") atau DM ke satu agent.
// `from` tercatat sebagai team.fromAgent — pemanggil wajib memberi prefix
// EL_PREFIX pada teks kalau pesannya dari EL, atau BOT_PREFIX kalau dari bot.
export async function sendTeamMessage(team, to, text) {
  if (!team.apiKey) throw new Error(`Tim "${team.id}" tidak punya kunci agent.`);
  const res = await fetch(`${team.serverUrl}/api/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${team.apiKey}`,
    },
    body: JSON.stringify({ to, text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`POST /api/messages ${team.id} gagal: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

// Verifikasi tim baru sebelum didaftarkan (/gabung). Server tim TIDAK
// punya endpoint baca yang butuh auth (GET /api/state publik), jadi kunci
// hanya bisa diverifikasi dengan satu tulis:
//   1. GET /api/state — server terjangkau + bentuk state sah.
//   2. GET /health — server sehat (ok: true).
//   3. POST /api/messages (jabat tangan) — kunci sah + sekaligus
//      mengumumkan bot ke ruang tim. Respons mengembalikan message.from,
//      jadi bot mempelajari id agent pemilik kunci itu.
// Kalau kunci salah, langkah 3 mengembalikan 401 dan tim TIDAK terdaftar.
// Mengembalikan { agentId, agents } — agents = id agent dari state.
export async function verifyTeamConnection(team) {
  const state = await fetchState(team);
  if (!state || !Array.isArray(state.agents)) {
    throw new Error(`Server ${team.serverUrl} menjawab, tapi bentuk /api/state tidak dikenal (bukan server tim?).`);
  }
  const health = await fetchHealth(team);
  if (!health || health.ok !== true) {
    throw new Error(`Server ${team.serverUrl} menjawab /health tidak sehat.`);
  }
  const result = await sendTeamMessage(
    team,
    "team",
    `${BOT_PREFIX}Bot Telegram terhubung ke tim ini. Pemilik tim bisa memantau dari Telegram — pesan dan perubahan tugas akan diteruskan ke sana.`
  );
  const agentId = result?.message?.from;
  if (!agentId) throw new Error("Jabat tangan berhasil, tapi server tidak mengembalikan id agent.");
  return { agentId, agents: state.agents.map((a) => a.id).filter(Boolean) };
}
