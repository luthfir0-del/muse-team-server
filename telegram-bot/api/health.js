// api/health.js — cek hidup bot (GET /api/health). Tanpa auth, tanpa
// nilai rahasia: hanya menampilkan ADA/TIDAKNYA tiap env var yang penting
// dan daftar tim (id + nama + status — TANPA url/kunci).

import { config } from "../lib/config.js";
import { createRegistry, publicTeam } from "../lib/registry.js";
import { createCursorStore } from "../lib/cursor.js";

export default async function handler(req, res) {
  let teams = [];
  try {
    const registry = createRegistry({ cfg: config });
    teams = (await registry.listTeams()).map((t) => {
      const p = publicTeam(t);
      return { id: p.id, name: p.name, status: p.status, source: p.source };
    });
  } catch (e) {
    teams = [{ error: e.message }];
  }

  // Probe cursor dedup (tanpa nilai rahasia): backend apa yang dipakai
  // poll/push, dan apakah baris cursor tim default bisa dibaca.
  // Kalau backend "memory" di Vercel, dedup antar-invokasi TIDAK jalan
  // (tiap peristiwa diteruskan berkali-kali). Kalau ok:false, kunci
  // Supabase di env bot salah/tidak bisa membaca tabel telegram_poll_state.
  let cursor = { backend: "unknown", ok: false };
  try {
    const store = createCursorStore(config);
    cursor.backend = store.kind || "unknown";
    const c = await store.load(config.defaultTeamId || "raden");
    cursor.ok = true;
    cursor.lastEventMs = c ? c.lastEventMs : null;
  } catch (e) {
    cursor.ok = false;
    cursor.error = String(e.message || e).slice(0, 120);
  }

  res.status(200).json({
    ok: true,
    service: "muse-team-telegram-bot",
    version: "multi-tim",
    time: new Date().toISOString(),
    configured: {
      botToken: Boolean(config.botToken),
      ownerChatId: Boolean(config.ownerChatId),
      webhookSecret: Boolean(config.webhookSecret),
      pollSecret: Boolean(config.pollSecret),
      supabaseRegistry: Boolean(config.supabaseUrl && config.supabaseServiceKey),
      requireElApproval: config.requireElApproval,
    },
    cursor,
    teams,
    pollWindowMinutes: config.pollWindowMinutes,
  });
}
