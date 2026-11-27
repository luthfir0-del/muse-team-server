// lib/registry.js — registry TIM bot (v2, multi-tim).
//
// Satu bot melayani banyak tim. Tiap tim terisolasi penuh: server, kunci,
// dan chat Telegram-nya sendiri. Tidak ada tim yang bisa melihat atau
// mengirim ke tim lain.
//
// Dua sumber tim (digabung; yang dinamis menang kalau id bentrok):
//   1. STATIS — TEAMS_JSON di env, atau tim utama v1 dari env lama
//      (TEAM_SERVER_URL + TEAM_API_KEY). Ubah = edit env + redeploy.
//   2. DINAMIS — tabel `telegram_teams` di Supabase (project yang sama
//      dengan server tim). Diisi runtime lewat perintah /gabung — tanpa
//      edit kode, tanpa restart. Butuh SUPABASE_URL + SUPABASE_SERVICE_KEY
//      di env bot (sekali saat setup). Tanpa keduanya: mode statis saja.
//
// Keamanan:
//   - `apiKey` tim TIDAK PERNAH keluar dari modul ini kecuali ke
//     lib/teamApi.js (untuk memanggil server tim itu). Fungsi `publicTeam`
//     mengembalikan tim TANPA kunci — pakai itu untuk log/respons/daftar.
//   - Akses Supabase memakai service_role key (server-side saja) lewat
//     PostgREST (fetch biasa, tanpa SDK). Tabel memakai RLS tanpa policy
//     publik, jadi anon key tidak bisa membaca apa pun.
//   - Pesan error Supabase disanitasi (pola JWT diredaksi) seperti
//     store.js server tim.
//
// Pilihan tim aktif per chat disimpan di memori proses (Map). Di mode
// long-polling lokal (dev) ini awet selama proses jalan; di Vercel,
// cold start mengembalikannya ke tim default (DEFAULT_TEAM_ID, lalu tim
// pertama yang terlihat). Itu batasan v2 yang didokumentasikan —
// persistensi pilihan (Supabase/Vercel KV) adalah peningkatan v3.

import { AGENT_IDS, config } from "./config.js";

const TEAM_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_TEAMS = 50;

// --- Validasi + normalisasi satu tim (dipakai statis & dinamis) --------
export function normalizeTeam(raw, source) {
  if (!raw || typeof raw !== "object") throw new Error("Data tim bukan objek.");
  const id = String(raw.id || "").trim().toLowerCase();
  if (!TEAM_ID_RE.test(id)) {
    throw new Error(`id tim "${raw.id}" tidak sah — pakai huruf kecil/angka/tanda -, maks 32 karakter.`);
  }
  const serverUrl = String(raw.serverUrl || "").trim().replace(/\/+$/, "");
  if (!/^https:\/\//.test(serverUrl) && !/^http:\/\/localhost(:\d+)?/.test(serverUrl)) {
    throw new Error(`URL server tim "${id}" harus https:// (http hanya untuk localhost).`);
  }
  const apiKey = String(raw.apiKey || "");
  if (!apiKey) throw new Error(`Tim "${id}" butuh kunci agent (apiKey).`);
  const name = String(raw.name || id).trim().slice(0, 64) || id;
  const fromAgent = String(raw.fromAgent || "ell").trim().toLowerCase() || "ell";
  const agents = Array.isArray(raw.agents) && raw.agents.length
    ? raw.agents.map((a) => String(a).trim().toLowerCase()).filter(Boolean)
    : [...AGENT_IDS];
  const ownerChatId = String(raw.ownerChatId || "").trim();
  if (!ownerChatId) throw new Error(`Tim "${id}" butuh ownerChatId (chat Telegram pemilik tim).`);
  const notifyChatId = String(raw.notifyChatId || ownerChatId).trim();
  const status = ["active", "pending", "disabled"].includes(raw.status) ? raw.status : "active";
  return {
    id, name, serverUrl, apiKey, fromAgent, agents,
    ownerChatId, notifyChatId, status,
    source: source || "static",
    createdAt: raw.createdAt || new Date().toISOString(),
    createdBy: raw.createdBy ? String(raw.createdBy) : "",
  };
}

// Tim untuk ditampilkan/log — TANPA kunci.
export function publicTeam(team) {
  if (!team) return null;
  const { apiKey: _apiKey, ...rest } = team;
  return rest;
}

// --- Tim statis dari env ------------------------------------------------
export function parseStaticTeams(cfg = config) {
  // TEAMS_JSON diutamakan; kalau kosong, tim utama v1 dari env lama.
  if (cfg.teamsJson) {
    let arr;
    try {
      arr = JSON.parse(cfg.teamsJson);
    } catch {
      throw new Error("TEAMS_JSON bukan JSON yang sah.");
    }
    if (!Array.isArray(arr) || !arr.length) throw new Error("TEAMS_JSON harus berisi array tim (minimal 1).");
    return arr.map((t) => normalizeTeam(t, "static"));
  }
  if (!cfg.botApiKey || !cfg.ownerChatId) return [];
  return [
    normalizeTeam(
      {
        id: "raden",
        name: "Tim Raden",
        serverUrl: cfg.teamServerUrl,
        apiKey: cfg.botApiKey,
        fromAgent: cfg.botFromAgent,
        agents: [...AGENT_IDS],
        ownerChatId: cfg.ownerChatId,
        notifyChatId: cfg.ownerChatId,
        status: "active",
      },
      "static"
    ),
  ];
}

// --- Klien Supabase minimal (PostgREST via fetch, tanpa SDK) ------------
function sanitizeErrorMessage(message) {
  return String(message || "Supabase error").replace(
    /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    "[KUNCI DIREDAKSI]"
  );
}

export function createSupabaseRegistryClient({ url, serviceKey }) {
  if (!url || !serviceKey) return null;
  const base = String(url).replace(/\/+$/, "");
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
  };
  async function rest(path, { method = "GET", body, prefer } = {}) {
    const h = { ...headers };
    if (prefer) h.Prefer = prefer;
    const res = await fetch(`${base}/rest/v1/${path}`, {
      method,
      headers: h,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Supabase ${method} ${path.split("?")[0]} gagal: HTTP ${res.status} ${sanitizeErrorMessage(data.message || "")}`.trim());
    }
    return data;
  }
  const TABLE = "telegram_teams";
  return {
    async list() {
      const rows = await rest(`${TABLE}?select=*&order=id`);
      return (Array.isArray(rows) ? rows : []).map((r) => ({
        id: r.id, name: r.name, serverUrl: r.server_url, apiKey: r.api_key,
        fromAgent: r.from_agent, agents: r.agents || [...AGENT_IDS],
        ownerChatId: String(r.owner_chat_id), notifyChatId: String(r.notify_chat_id || r.owner_chat_id),
        status: r.status, createdAt: r.created_at, createdBy: String(r.created_by || ""),
      }));
    },
    async insert(team) {
      const rows = await rest(TABLE, {
        method: "POST",
        prefer: "return=representation",
        body: {
          id: team.id, name: team.name, server_url: team.serverUrl, api_key: team.apiKey,
          from_agent: team.fromAgent, agents: team.agents,
          owner_chat_id: team.ownerChatId, notify_chat_id: team.notifyChatId,
          status: team.status, created_by: team.createdBy || null,
        },
      });
      if (!Array.isArray(rows) || !rows.length) throw new Error("Supabase insert tidak mengembalikan baris.");
      return rows[0];
    },
    async update(id, patch) {
      const body = {};
      if (patch.status) body.status = patch.status;
      if (patch.notifyChatId) body.notify_chat_id = patch.notifyChatId;
      if (patch.name) body.name = patch.name;
      if (patch.apiKey) body.api_key = patch.apiKey;
      if (patch.fromAgent) body.from_agent = patch.fromAgent;
      if (patch.agents) body.agents = patch.agents;
      await rest(`${TABLE}?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", body });
    },
    async remove(id) {
      await rest(`${TABLE}?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
    },
    // --- Kursor poll (tabel telegram_poll_state, lihat supabase-teams.sql).
    // Satu baris per tim: peristiwa terakhir yang sudah diteruskan.
    async getPollState(teamId) {
      const rows = await rest(`telegram_poll_state?select=*&team_id=eq.${encodeURIComponent(teamId)}`);
      const r = Array.isArray(rows) ? rows[0] : null;
      if (!r) return null;
      return { lastEventMs: Number(r.last_event_ms) || 0, seenKeys: Array.isArray(r.seen_keys) ? r.seen_keys : [] };
    },
    async setPollState(teamId, cursor) {
      await rest("telegram_poll_state", {
        method: "POST",
        prefer: "resolution=merge-duplicates,return=minimal",
        body: {
          team_id: teamId,
          last_event_ms: cursor.lastEventMs,
          seen_keys: cursor.seenKeys || [],
        },
      });
    },
  };
}

// --- Registry: gabungan statis + dinamis -------------------------------
export function createRegistry({ cfg = config, supabase = undefined } = {}) {
  const sb =
    supabase !== undefined
      ? supabase
      : createSupabaseRegistryClient({ url: cfg.supabaseUrl, serviceKey: cfg.supabaseServiceKey });

  // Pilihan tim aktif per chat (memori proses saja — lihat catatan atas).
  const activeByChat = new Map();

  async function listTeams() {
    const statics = parseStaticTeams(cfg);
    let dynamics = [];
    if (sb) {
      try {
        dynamics = (await sb.list()).map((t) => normalizeTeam(t, "dynamic"));
      } catch (e) {
        // Registry dinamis gagal dibaca — statis tetap jalan, jangan crash.
        console.error("[registry] Supabase list gagal, pakai tim statis saja:", e.message);
      }
    }
    const byId = new Map();
    for (const t of statics) byId.set(t.id, t);
    for (const t of dynamics) byId.set(t.id, t); // dinamis menang kalau id bentrok
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  async function getTeam(id) {
    const teams = await listTeams();
    return teams.find((t) => t.id === id) || null;
  }

  function isSuperOwner(chatId) {
    return Boolean(cfg.ownerChatId) && String(chatId) === String(cfg.ownerChatId);
  }

  // Tim yang boleh dilihat/diperintah dari satu chat Telegram.
  // Super-owner (EL): semua tim. Pemilik tim lain: hanya timnya sendiri.
  // Chat grup yang terikat sebagai notifyChatId sebuah tim: tim itu saja.
  function teamsVisibleTo(teams, chatId) {
    const cid = String(chatId);
    if (isSuperOwner(cid)) return teams;
    return teams.filter((t) => t.ownerChatId === cid || t.notifyChatId === cid);
  }

  function resolveTeam(teams, chatId) {
    const visible = teamsVisibleTo(teams, chatId).filter((t) => t.status === "active");
    if (!visible.length) return { team: null, visible: teamsVisibleTo(teams, chatId) };
    if (visible.length === 1) return { team: visible[0], visible };
    const picked = activeByChat.get(String(chatId));
    const team =
      visible.find((t) => t.id === picked) ||
      visible.find((t) => t.id === cfg.defaultTeamId) ||
      visible[0];
    return { team, visible };
  }

  function setActiveTeam(chatId, teamId) {
    activeByChat.set(String(chatId), teamId);
  }

  return {
    isDynamicEnabled: () => Boolean(sb),
    // Kalau true: tim yang gabung lewat /gabung berstatus "pending" dan
    // harus disetujui EL (/setuju) sebelum aktif.
    requiresApproval: () => Boolean(cfg.requireElApproval),
    isSuperOwner,
    listTeams,
    getTeam,
    teamsVisibleTo,
    resolveTeam,
    setActiveTeam,

    // Daftarkan tim baru (dinamis). Validasi + cek duplikat dulu;
    // verifikasi koneksi dilakukan pemanggil (verifyTeamConnection)
    // SEBELUM memanggil ini — registry hanya menyimpan.
    async registerTeam(input) {
      if (!sb) throw new Error("Registry dinamis belum aktif — set SUPABASE_URL + SUPABASE_SERVICE_KEY di env bot (lihat README).");
      const team = normalizeTeam(input, "dynamic");
      const existing = await getTeam(team.id);
      if (existing) throw new Error(`Tim "${team.id}" sudah ada (${existing.name}). Pakai id lain.`);
      const all = await listTeams();
      if (all.length >= MAX_TEAMS) throw new Error(`Batas tim tercapai (${MAX_TEAMS}).`);
      await sb.insert(team);
      return team;
    },

    async setTeamStatus(id, status) {
      if (!["active", "pending", "disabled"].includes(status)) throw new Error(`Status "${status}" tidak dikenal.`);
      const team = await getTeam(id);
      if (!team) throw new Error(`Tim "${id}" tidak ditemukan.`);
      if (team.source !== "dynamic") {
        throw new Error(`Tim "${id}" berasal dari env (statis) — ubah statusnya lewat env, bukan bot.`);
      }
      await sb.update(id, { status });
      return { ...team, status };
    },

    async setNotifyChat(id, notifyChatId) {
      const team = await getTeam(id);
      if (!team) throw new Error(`Tim "${id}" tidak ditemukan.`);
      if (team.source !== "dynamic") {
        throw new Error(`Tim "${id}" berasal dari env (statis) — ubah notify chat lewat TEAMS_JSON, bukan bot.`);
      }
      await sb.update(id, { notifyChatId: String(notifyChatId) });
      return { ...team, notifyChatId: String(notifyChatId) };
    },

    async removeTeam(id) {
      const team = await getTeam(id);
      if (!team) throw new Error(`Tim "${id}" tidak ditemukan.`);
      if (team.source !== "dynamic") {
        throw new Error(`Tim "${id}" berasal dari env (statis) — hapus lewat TEAMS_JSON, bukan bot.`);
      }
      await sb.remove(id);
      return team;
    },
  };
}
