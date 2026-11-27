// api/health.js — cek hidup bot (GET /api/health). Tanpa auth, tanpa
// nilai rahasia: hanya menampilkan ADA/TIDAKNYA tiap env var yang penting
// dan daftar tim (id + nama + status — TANPA url/kunci).

import { config } from "../lib/config.js";
import { createRegistry, publicTeam } from "../lib/registry.js";

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
    teams,
    pollWindowMinutes: config.pollWindowMinutes,
  });
}
