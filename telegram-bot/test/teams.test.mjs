// test/teams.test.mjs — tes lib/registry.js (multi-tim) tanpa jaringan.
// Mencakup: parsing tim statis, validasi, isolasi antar tim, routing chat
// -> tim, pilihan tim aktif, dan pendaftaran tim dinamis.

import test from "node:test";
import assert from "node:assert/strict";
import {
  createRegistry,
  normalizeTeam,
  parseStaticTeams,
  publicTeam,
} from "../lib/registry.js";

// Supabase palsu (in-memory) dengan antarmuka yang sama seperti
// createSupabaseRegistryClient — termasuk pemetaan camelCase <-> snake_case
// seperti PostgREST (insert/update menyimpan snake_case, list mengembalikan
// camelCase). Dipakai createRegistry.
function toRow(t) {
  return {
    id: t.id, name: t.name, server_url: t.serverUrl, api_key: t.apiKey,
    from_agent: t.fromAgent, agents: t.agents,
    owner_chat_id: t.ownerChatId, notify_chat_id: t.notifyChatId,
    status: t.status, created_at: t.createdAt, created_by: t.createdBy || null,
  };
}
function fromRow(r) {
  return {
    id: r.id, name: r.name, serverUrl: r.server_url, apiKey: r.api_key,
    fromAgent: r.from_agent, agents: r.agents,
    ownerChatId: String(r.owner_chat_id), notifyChatId: String(r.notify_chat_id || r.owner_chat_id),
    status: r.status, createdAt: r.created_at, createdBy: String(r.created_by || ""),
  };
}
function fakeSupabase(rows = []) {
  const store = rows.map(toRow);
  return {
    async list() {
      return store.map(fromRow);
    },
    async insert(team) {
      store.push(toRow(team));
      return { ...team };
    },
    async update(id, patch) {
      const row = store.find((r) => r.id === id);
      if (!row) throw new Error("tidak ditemukan");
      if (patch.status) row.status = patch.status;
      if (patch.notifyChatId) row.notify_chat_id = patch.notifyChatId;
      if (patch.name) row.name = patch.name;
      if (patch.apiKey) row.api_key = patch.apiKey;
      if (patch.fromAgent) row.from_agent = patch.fromAgent;
      if (patch.agents) row.agents = patch.agents;
    },
    async remove(id) {
      const i = store.findIndex((r) => r.id === id);
      if (i >= 0) store.splice(i, 1);
    },
    _store: store,
  };
}

function cfg(overrides = {}) {
  return {
    teamsJson: "",
    teamServerUrl: "https://muse-team-server.vercel.app",
    botApiKey: "",
    botFromAgent: "ell",
    ownerChatId: "100", // EL
    defaultTeamId: "raden",
    requireElApproval: false,
    supabaseUrl: "",
    supabaseServiceKey: "",
    ...overrides,
  };
}

function team(overrides = {}) {
  return {
    id: "raden",
    name: "Tim Raden",
    serverUrl: "https://muse-team-server.vercel.app",
    apiKey: "kunci-rahasia-raden",
    fromAgent: "ell",
    agents: ["mas", "mbak", "ell"],
    ownerChatId: "100",
    notifyChatId: "100",
    status: "active",
    ...overrides,
  };
}

// --- Parsing + validasi -------------------------------------------------
test("tim statis dari TEAMS_JSON", () => {
  const teams = parseStaticTeams(
    cfg({ teamsJson: JSON.stringify([team(), team({ id: "kampung", name: "Tim Kampung", ownerChatId: "200" })]) })
  );
  assert.equal(teams.length, 2);
  assert.equal(teams[0].source, "static");
  assert.equal(teams[1].id, "kampung");
});

test("tanpa TEAMS_JSON: tim utama v1 dari env lama", () => {
  const teams = parseStaticTeams(cfg({ botApiKey: "kunci-raden" }));
  assert.equal(teams.length, 1);
  assert.equal(teams[0].id, "raden");
  assert.equal(teams[0].name, "Tim Raden");
});

test("tanpa TEAMS_JSON dan tanpa kunci: tidak ada tim statis", () => {
  assert.equal(parseStaticTeams(cfg()).length, 0);
});

test("validasi tim: id salah, URL bukan https, kunci kosong ditolak", () => {
  assert.throws(() => normalizeTeam(team({ id: "Tim Raden!" }), "static"), /id tim/);
  assert.throws(() => normalizeTeam(team({ serverUrl: "http://contoh.com" }), "static"), /https/);
  assert.throws(() => normalizeTeam(team({ apiKey: "" }), "static"), /kunci agent/);
  assert.throws(() => normalizeTeam(team({ ownerChatId: "" }), "static"), /ownerChatId/);
});

test("publicTeam menghilangkan kunci", () => {
  const p = publicTeam(team());
  assert.equal(p.apiKey, undefined);
  assert.equal(p.id, "raden");
  assert.equal(p.serverUrl, "https://muse-team-server.vercel.app");
});

// --- Isolasi antar tim ---------------------------------------------------
test("isolasi: super-owner melihat semua, pemilik tim hanya timnya, orang asing tidak ada", async () => {
  const sb = fakeSupabase([
    team({ id: "kampung", name: "Tim Kampung", ownerChatId: "200", notifyChatId: "200" }),
  ]);
  const reg = createRegistry({
    cfg: cfg({ teamsJson: JSON.stringify([team()]) }),
    supabase: sb,
  });
  const teams = await reg.listTeams();
  assert.equal(teams.length, 2);

  assert.equal(reg.teamsVisibleTo(teams, "100").length, 2); // EL
  assert.deepEqual(
    reg.teamsVisibleTo(teams, "200").map((t) => t.id),
    ["kampung"]
  );
  assert.equal(reg.teamsVisibleTo(teams, "999").length, 0);
  assert.ok(reg.isSuperOwner("100"));
  assert.ok(!reg.isSuperOwner("200"));
});

test("isolasi: chat grup terikat notifyChatId hanya melihat tim itu", async () => {
  const reg = createRegistry({
    cfg: cfg({ teamsJson: JSON.stringify([team({ notifyChatId: "-555" })]) }),
    supabase: null,
  });
  const teams = await reg.listTeams();
  assert.deepEqual(
    reg.teamsVisibleTo(teams, "-555").map((t) => t.id),
    ["raden"]
  );
});

// --- Routing chat -> tim aktif -------------------------------------------
test("routing: chat 1 tim langsung memakai tim itu; chat EL memakai tim default lalu /tim", async () => {
  const reg = createRegistry({
    cfg: cfg({ teamsJson: JSON.stringify([team(), team({ id: "kampung", name: "Tim Kampung", ownerChatId: "200" })]) }),
    supabase: null,
  });
  const teams = await reg.listTeams();

  // Pemilik kampung (1 tim terlihat) -> timnya langsung.
  assert.equal(reg.resolveTeam(teams, "200").team.id, "kampung");

  // EL (2 tim) -> default "raden", lalu pindah dengan setActiveTeam.
  assert.equal(reg.resolveTeam(teams, "100").team.id, "raden");
  reg.setActiveTeam("100", "kampung");
  assert.equal(reg.resolveTeam(teams, "100").team.id, "kampung");
});

test("routing: tim pending/disabled tidak bisa dipakai", async () => {
  const reg = createRegistry({
    cfg: cfg({ teamsJson: JSON.stringify([team(), team({ id: "kampung", name: "Tim Kampung", ownerChatId: "200", status: "pending" })]) }),
    supabase: null,
  });
  const teams = await reg.listTeams();
  // EL hanya melihat tim aktif; kampung pending tidak ter-resolve.
  assert.equal(reg.resolveTeam(teams, "100").team.id, "raden");
  // Pemilik kampung tidak punya tim aktif sama sekali.
  assert.equal(reg.resolveTeam(teams, "200").team, null);
});

// --- Pendaftaran tim dinamis ---------------------------------------------
test("registerTeam: berhasil, lalu terlihat di listTeams", async () => {
  const sb = fakeSupabase();
  const reg = createRegistry({ cfg: cfg({ botApiKey: "kunci-raden" }), supabase: sb });
  const saved = await reg.registerTeam(
    team({ id: "naraya", name: "Tim Naraya", ownerChatId: "300", notifyChatId: "300" })
  );
  assert.equal(saved.source, "dynamic");
  const found = await reg.getTeam("naraya");
  assert.equal(found.name, "Tim Naraya");
  assert.equal(sb._store.length, 1);
});

test("registerTeam: id duplikat ditolak", async () => {
  const reg = createRegistry({
    cfg: cfg({ teamsJson: JSON.stringify([team()]) }),
    supabase: fakeSupabase(),
  });
  await assert.rejects(
    reg.registerTeam(team({ id: "raden", ownerChatId: "300" })),
    /sudah ada/
  );
});

test("registerTeam: tanpa Supabase ditolak (mode statis)", async () => {
  const reg = createRegistry({ cfg: cfg({ botApiKey: "kunci-raden" }), supabase: null });
  await assert.rejects(reg.registerTeam(team({ id: "baru", ownerChatId: "300" })), /dinamis belum aktif/);
});

test("setTeamStatus/removeTeam: hanya tim dinamis", async () => {
  const sb = fakeSupabase();
  const reg = createRegistry({
    cfg: cfg({ teamsJson: JSON.stringify([team()]) }),
    supabase: sb,
  });
  await reg.registerTeam(team({ id: "kampung", ownerChatId: "200", notifyChatId: "200" }));
  const updated = await reg.setTeamStatus("kampung", "disabled");
  assert.equal(updated.status, "disabled");

  // Tim statis tidak bisa diubah lewat bot.
  await assert.rejects(reg.setTeamStatus("raden", "disabled"), /env \(statis\)/);
  await assert.rejects(reg.removeTeam("raden"), /env \(statis\)/);

  const removed = await reg.removeTeam("kampung");
  assert.equal(removed.id, "kampung");
  assert.equal(await reg.getTeam("kampung"), null);
});
