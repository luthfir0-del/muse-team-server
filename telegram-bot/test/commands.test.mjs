// test/commands.test.mjs — tes lib/commands.js (v2, multi-tim) dengan
// registry asli + fetch/send palsu. Mencakup: routing ke tim yang benar,
// isolasi antar tim, onboarding /gabung, penolakan chat tak terdaftar.

import test from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "../lib/registry.js";
import { handleTelegramMessage } from "../lib/commands.js";

const EL = "100";
const KAMPUNG_OWNER = "200";
const STRANGER = "999";

// Supabase palsu (in-memory) dengan antarmuka yang sama seperti
// createSupabaseRegistryClient — termasuk pemetaan camelCase <-> snake_case
// seperti PostgREST (insert/update menyimpan snake_case, list mengembalikan
// camelCase).
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

function team(overrides = {}) {
  return {
    id: "raden",
    name: "Tim Raden",
    serverUrl: "https://tim-raden.example",
    apiKey: "kunci-raden",
    fromAgent: "ell",
    agents: ["mas", "mbak", "ell"],
    ownerChatId: EL,
    notifyChatId: EL,
    status: "active",
    ...overrides,
  };
}

function cfg(overrides = {}) {
  return {
    teamsJson: JSON.stringify([
      team(),
      team({ id: "kampung", name: "Tim Kampung", serverUrl: "https://tim-kampung.example", apiKey: "kunci-kampung", ownerChatId: KAMPUNG_OWNER, notifyChatId: KAMPUNG_OWNER }),
    ]),
    teamServerUrl: "",
    botApiKey: "",
    botFromAgent: "ell",
    ownerChatId: EL,
    defaultTeamId: "raden",
    requireElApproval: false,
    supabaseUrl: "",
    supabaseServiceKey: "",
    ...overrides,
  };
}

function fakeState(teamId = "raden") {
  return {
    updated: new Date().toISOString(),
    agents: [
      { id: "mas", name: "Mas", status: "connected", currentActivity: "Render", tasksDone: 1, tasksTotal: 2 },
      { id: "mbak", name: "Mbak", status: "connected", currentActivity: "Nulis", tasksDone: 0, tasksTotal: 1 },
      { id: "ell", name: "Ell", status: "connected", currentActivity: "Posting", tasksDone: 3, tasksTotal: 3 },
    ],
    tasks: [{ id: "t1", agent: "mas", title: `Tugas ${teamId}`, status: "done", time: "19:00" }],
    messages: [],
    activity: [],
  };
}

// deps untuk handleTelegramMessage. `sent` mencatat kiriman ke tim,
// `verify` mengendalikan hasil verifikasi /gabung.
function makeDeps({ sent, sb = fakeSupabase(), cfgOverrides = {}, verify } = {}) {
  const registry = createRegistry({ cfg: cfg(cfgOverrides), supabase: sb });
  return {
    registry,
    ownerChatId: EL,
    fetchState: async (t) => fakeState(t.id),
    sendTeamMessage: async (team, to, text) => {
      sent.push({ team: team.id, to, text });
      return { ok: true };
    },
    verifyTeamConnection:
      verify ||
      (async (candidate) => {
        if (candidate.apiKey === "kunci-salah") throw new Error("POST /api/messages gagal: HTTP 401");
        return { agentId: "ell", agents: ["mas", "mbak", "ell"] };
      }),
    deleteMessage: async () => true,
    _sb: sb,
  };
}

const msg = (chatId, text, extra = {}) => ({ chat: { id: chatId, type: "private" }, from: { id: chatId }, text, ...extra });

// --- Bootstrap + chat tak terdaftar ---------------------------------------
test("/start tanpa OWNER_CHAT_ID membalas chat id (bootstrap)", async () => {
  const deps = makeDeps({ sent: [], cfgOverrides: { ownerChatId: "" } });
  deps.ownerChatId = "";
  const r = await handleTelegramMessage(msg(777, "/start"), deps);
  assert.match(r.reply, /777/);
  assert.match(r.reply, /OWNER_CHAT_ID/);
});

test("chat asing: /start menjelaskan cara gabung, pesan biasa ditolak, /gabung tetap boleh", async () => {
  const sent = [];
  const deps = makeDeps({ sent });
  const start = await handleTelegramMessage(msg(STRANGER, "/start"), deps);
  assert.match(start.reply, /\/gabung/);

  const plain = await handleTelegramMessage(msg(STRANGER, "halo"), deps);
  assert.match(plain.reply, /hanya untuk tim yang terdaftar/);
  assert.equal(sent.length, 0);
});

// --- Routing tim ----------------------------------------------------------
test("/tim: EL melihat 2 tim, pindah ke kampung, /status lalu memakai kampung", async () => {
  const sent = [];
  const deps = makeDeps({ sent });
  const list = await handleTelegramMessage(msg(EL, "/tim"), deps);
  assert.match(list.reply, /raden/);
  assert.match(list.reply, /kampung/);

  const switched = await handleTelegramMessage(msg(EL, "/tim kampung"), deps);
  assert.match(switched.reply, /Tim Kampung/);

  const status = await handleTelegramMessage(msg(EL, "/status"), deps);
  assert.match(status.reply, /Tim Kampung/);
  const tugas = await handleTelegramMessage(msg(EL, "/tugas"), deps);
  assert.match(tugas.reply, /Tugas kampung/);
});

test("/status <id-tim> memakai tim itu tanpa pindah", async () => {
  const deps = makeDeps({ sent: [] });
  const r = await handleTelegramMessage(msg(EL, "/status kampung"), deps);
  assert.match(r.reply, /Tim Kampung/);
  // Tim aktif tetap raden — cek lewat /tim.
  const list = await handleTelegramMessage(msg(EL, "/tim"), deps);
  assert.match(list.reply, /▶.*raden/);
});

test("pesan biasa EL diteruskan ke tim aktif dengan prefix [EL]", async () => {
  const sent = [];
  const deps = makeDeps({ sent });
  const r = await handleTelegramMessage(msg(EL, "tolong cek render ya"), deps);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].team, "raden");
  assert.equal(sent[0].to, "team");
  assert.equal(sent[0].text, "[EL] tolong cek render ya");
  assert.match(r.reply, /Terkirim/);
});

test("/dm ke target sah, /dm ke target salah ditolak", async () => {
  const sent = [];
  const deps = makeDeps({ sent });
  const ok = await handleTelegramMessage(msg(EL, "/dm mas cek Part 4"), deps);
  assert.equal(sent[0].team, "raden");
  assert.equal(sent[0].to, "mas");
  assert.match(ok.reply, /Terkirim/);

  const sent2 = [];
  const deps2 = makeDeps({ sent: sent2 });
  const bad = await handleTelegramMessage(msg(EL, "/dm budi halo"), deps2);
  assert.equal(sent2.length, 0);
  assert.match(bad.reply, /tidak dikenal/);
});

// --- Isolasi antar tim ----------------------------------------------------
test("isolasi: pemilik kampung tidak bisa mengakses tim raden", async () => {
  const deps = makeDeps({ sent: [] });
  const status = await handleTelegramMessage(msg(KAMPUNG_OWNER, "/status raden"), deps);
  assert.match(status.reply, /tidak ada di daftar kamu/);

  const switched = await handleTelegramMessage(msg(KAMPUNG_OWNER, "/tim raden"), deps);
  assert.match(switched.reply, /tidak ada di daftar kamu/);

  // Tapi /status miliknya sendiri jalan.
  const own = await handleTelegramMessage(msg(KAMPUNG_OWNER, "/status"), deps);
  assert.match(own.reply, /Tim Kampung/);
});

test("isolasi: pesan pemilik kampung hanya ke tim kampung", async () => {
  const sent = [];
  const deps = makeDeps({ sent });
  await handleTelegramMessage(msg(KAMPUNG_OWNER, "halo tim"), deps);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].team, "kampung");
});

// --- Onboarding /gabung ---------------------------------------------------
test("/gabung sukses: tim terdaftar, kunci tidak pernah muncul di balasan", async () => {
  const sent = [];
  const deps = makeDeps({ sent });
  const r = await handleTelegramMessage(
    msg(STRANGER, "/gabung naraya https://tim-naraya.example kunci-naraya-baru Tim Naraya"),
    deps
  );
  assert.match(r.reply, /berhasil gabung/);
  assert.match(r.reply, /naraya/);
  assert.ok(!r.reply.includes("kunci-naraya-baru"), "kunci tidak boleh muncul di balasan");
  assert.equal(deps._sb._store.length, 1);
  assert.equal(deps._sb._store[0].id, "naraya");
  assert.equal(deps._sb._store[0].owner_chat_id, STRANGER);
  // EL diberitahu (notify), tanpa kunci juga.
  assert.ok(r.notify?.length === 1);
  assert.equal(r.notify[0].chatId, EL);
  assert.ok(!r.notify[0].text.includes("kunci-naraya-baru"));
});

test("/gabung dari grup: pemilik = pengirim, notifikasi = grup", async () => {
  const deps = makeDeps({ sent: [] });
  const r = await handleTelegramMessage(
    { chat: { id: -555, type: "supergroup" }, from: { id: 300 }, message_id: 42, text: "/gabung naraya https://tim-naraya.example kunci-naraya" },
    deps
  );
  assert.match(r.reply, /berhasil gabung/);
  assert.equal(deps._sb._store[0].owner_chat_id, "300");
  assert.equal(deps._sb._store[0].notify_chat_id, "-555");
});

test("/gabung kunci salah: verifikasi gagal, tim tidak terdaftar", async () => {
  const deps = makeDeps({ sent: [] });
  const r = await handleTelegramMessage(
    msg(STRANGER, "/gabung gagal https://tim-gagal.example kunci-salah"),
    deps
  );
  assert.match(r.reply, /Verifikasi.*gagal/);
  assert.equal(deps._sb._store.length, 0);
});

test("/gabung tanpa argumen lengkap: menampilkan cara pakai", async () => {
  const deps = makeDeps({ sent: [] });
  const r = await handleTelegramMessage(msg(STRANGER, "/gabung naraya"), deps);
  assert.match(r.reply, /Pakai:.*\/gabung/);
});

test("/gabung mode statis (tanpa Supabase): ditolak dengan penjelasan", async () => {
  const sent = [];
  const registry = createRegistry({ cfg: cfg(), supabase: null });
  const deps = {
    registry,
    ownerChatId: EL,
    fetchState: async (t) => fakeState(t.id),
    sendTeamMessage: async () => ({ ok: true }),
    verifyTeamConnection: async () => ({ agentId: "ell", agents: ["mas", "mbak", "ell"] }),
  };
  const r = await handleTelegramMessage(msg(STRANGER, "/gabung baru https://tim-baru.example kunci"), deps);
  assert.match(r.reply, /belum aktif/);
  assert.match(r.reply, /SUPABASE/);
});

// --- Persetujuan + hapus + notify -----------------------------------------
test("/setuju hanya EL; EL menyetujui tim pending", async () => {
  const sb = fakeSupabase([
    {
      id: "pending1", name: "Tim Pending", serverUrl: "https://tim-pending.example",
      apiKey: "kunci-pending", fromAgent: "ell", agents: ["mas", "mbak", "ell"],
      ownerChatId: "300", notifyChatId: "300", status: "pending",
      createdAt: new Date().toISOString(), createdBy: "300",
    },
  ]);
  const deps = makeDeps({ sent: [], sb });

  const denied = await handleTelegramMessage(msg(KAMPUNG_OWNER, "/setuju pending1"), deps);
  assert.match(denied.reply, /Hanya EL/);

  const ok = await handleTelegramMessage(msg(EL, "/setuju pending1"), deps);
  assert.match(ok.reply, /disetujui dan aktif/);
  assert.equal(sb._store[0].status, "active");
  assert.ok(ok.notify?.length === 1);
  assert.equal(ok.notify[0].chatId, "300");
});

test("/notify: pemilik tim mengatur chat ini sebagai tujuan notifikasi", async () => {
  const sb = fakeSupabase();
  const deps = makeDeps({ sent: [], sb });
  // Daftarkan tim dinamis dulu lewat /gabung, lalu /notify dari grup.
  await handleTelegramMessage(msg(300, "/gabung naraya https://tim-naraya.example kunci-naraya"), deps);
  const r = await handleTelegramMessage(
    { chat: { id: -777, type: "group" }, from: { id: 300 }, text: "/notify naraya" },
    deps
  );
  assert.match(r.reply, /Notifikasi tim.*chat ini/);
  assert.equal(sb._store[0].notify_chat_id, "-777");
});

test("/hapus: pemilik tim bisa menghapus; orang asing tidak bisa", async () => {
  const sb = fakeSupabase();
  const deps = makeDeps({ sent: [], sb });
  await handleTelegramMessage(msg(300, "/gabung naraya https://tim-naraya.example kunci-naraya"), deps);

  const denied = await handleTelegramMessage(msg(STRANGER, "/hapus naraya"), deps);
  assert.match(denied.reply, /Hanya pemilik tim/);
  assert.equal(sb._store.length, 1);

  const ok = await handleTelegramMessage(msg(300, "/hapus naraya"), deps);
  assert.match(ok.reply, /sudah dihapus/);
  assert.equal(sb._store.length, 0);
});

test("perintah tidak dikenal mengarah ke /help", async () => {
  const deps = makeDeps({ sent: [] });
  const r = await handleTelegramMessage(msg(EL, "/ngawur"), deps);
  assert.match(r.reply, /\/help/);
});
