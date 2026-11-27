// test/cursor.test.mjs — tes lib/cursor.js (dedup push vs poll) tanpa jaringan.
// Mencakup: saring peristiwa segar, majukan cursor, store memori, dan
// dedup pollAllTeams antar run (store bersama + store Supabase palsu yang
// bertahan antar "invokasi" terpisah).

import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceCursor,
  createMemoryCursorStore,
  createSupabaseCursorStore,
  filterFreshEvents,
} from "../lib/cursor.js";
import { pollAllTeams } from "../lib/pollTeams.js";
import { createRegistry } from "../lib/registry.js";

const NOW = Date.now();
const msg = (id, ageMs, text = "halo") => ({ kind: "message", id, time: NOW - ageMs, from: "mas", to: "team", text });
const act = (agent, event, ageMs) => ({ kind: "activity", time: NOW - ageMs, agent, event });

test("filterFreshEvents: tanpa cursor semua peristiwa segar", () => {
  const evs = [msg("m1", 60_000), act("mas", "update status: kerja", 30_000)];
  assert.equal(filterFreshEvents(evs, null).length, 2);
});

test("filterFreshEvents: hanya yang lebih baru dari lastEventMs", () => {
  const evs = [msg("m1", 120_000), msg("m2", 60_000), msg("m3", 10_000)];
  const out = filterFreshEvents(evs, { lastEventMs: NOW - 90_000, seenKeys: [] });
  assert.deepEqual(out.map((e) => e.id), ["m2", "m3"]);
});

test("filterFreshEvents: milidetik sama — kunci yang sudah dilihat dilewati", () => {
  const t = NOW - 5_000;
  const evs = [
    { kind: "message", id: "m1", time: t, from: "mas", to: "team", text: "a" },
    { kind: "message", id: "m2", time: t, from: "mas", to: "team", text: "b" },
  ];
  const out = filterFreshEvents(evs, { lastEventMs: t, seenKeys: ["m:m1"] });
  assert.deepEqual(out.map((e) => e.id), ["m2"]);
});

test("advanceCursor: maju ke waktu terbaru, simpan kunci waktu itu saja", () => {
  const evs = [msg("m1", 60_000), msg("m2", 10_000), msg("m3", 10_000)];
  const c = advanceCursor(null, evs);
  assert.equal(c.lastEventMs, NOW - 10_000);
  assert.deepEqual([...c.seenKeys].sort(), ["m:m2", "m:m3"]);
});

test("advanceCursor: batch kedua di milidetik sama menggabungkan kunci", () => {
  const t = NOW - 5_000;
  const c1 = advanceCursor(null, [{ kind: "message", id: "m1", time: t, from: "mas", to: "team", text: "a" }]);
  const c2 = advanceCursor(c1, [{ kind: "message", id: "m2", time: t, from: "mas", to: "team", text: "b" }]);
  assert.equal(c2.lastEventMs, t);
  assert.deepEqual([...c2.seenKeys].sort(), ["m:m1", "m:m2"]);
});

test("advanceCursor: tanpa peristiwa, cursor tidak berubah", () => {
  const c = { lastEventMs: 123, seenKeys: ["m:m1"] };
  assert.deepEqual(advanceCursor(c, []), c);
});

test("memory store: simpan + baca + tim tak dikenal null", async () => {
  const store = createMemoryCursorStore();
  assert.equal(await store.load("raden"), null);
  await store.save("raden", { lastEventMs: 999, seenKeys: ["m:m1"] });
  assert.deepEqual(await store.load("raden"), { lastEventMs: 999, seenKeys: ["m:m1"] });
  assert.equal(await store.load("lain"), null);
});

// --- Dedup pollAllTeams antar run ---------------------------------------

function team(overrides = {}) {
  return {
    id: "raden",
    name: "Tim Raden",
    serverUrl: "https://tim-raden.example",
    apiKey: "kunci-rahasia",
    fromAgent: "ell",
    agents: ["mas", "mbak", "ell"],
    ownerChatId: "100",
    notifyChatId: "100",
    status: "active",
    ...overrides,
  };
}

function registryWith(teams) {
  return createRegistry({
    cfg: {
      teamsJson: JSON.stringify(teams),
      teamServerUrl: "",
      botApiKey: "",
      botFromAgent: "ell",
      ownerChatId: "100",
      defaultTeamId: "raden",
      requireElApproval: false,
      supabaseUrl: "",
      supabaseServiceKey: "",
    },
    supabase: null,
  });
}

function stateWith(messages) {
  const iso = (ms) => new Date(ms).toISOString();
  return {
    updated: iso(NOW),
    agents: [{ id: "mas", name: "Mas", status: "connected", currentActivity: "-", tasksDone: 0, tasksTotal: 0 }],
    tasks: [],
    messages: messages.map(([id, text, ageMs]) => ({ id, from: "mas", to: "team", text, time: iso(NOW - ageMs) })),
    activity: [],
  };
}

test("pollAllTeams + store bersama: peristiwa sama hanya diteruskan sekali", async () => {
  const registry = registryWith([team()]);
  const store = createMemoryCursorStore();
  const sent = [];
  const args = {
    registry,
    fetchState: async () => stateWith([["m1", "halo tim", 30_000]]),
    sendTelegram: async (chatId, text) => sent.push({ chatId, text }),
    pollWindowMinutes: 2,
    cursorStore: store,
  };
  const r1 = await pollAllTeams(args);
  assert.equal(r1[0].forwarded, 1);
  assert.equal(sent.length, 1);
  const r2 = await pollAllTeams(args);
  assert.equal(r2[0].forwarded, 0);
  assert.equal(sent.length, 1);
});

test("pollAllTeams + store Supabase palsu: dedup bertahan antar invokasi", async () => {
  // Simulasi dua invokasi serverless terpisah: tiap invokasi membuat
  // store BARU dari client Supabase yang sama (state persisten di "DB").
  const db = new Map();
  const fakeClient = {
    async getPollState(teamId) {
      return db.get(teamId) || null;
    },
    async setPollState(teamId, cursor) {
      db.set(teamId, { ...cursor });
    },
  };
  const registry = registryWith([team()]);
  const sent = [];
  const base = {
    registry,
    fetchState: async () => stateWith([["m1", "halo tim", 30_000]]),
    sendTelegram: async (chatId, text) => sent.push({ chatId, text }),
    pollWindowMinutes: 2,
  };
  const r1 = await pollAllTeams({ ...base, cursorStore: createSupabaseCursorStore(fakeClient) });
  assert.equal(r1[0].forwarded, 1);
  // Invokasi kedua: store baru, "DB" yang sama.
  const r2 = await pollAllTeams({ ...base, cursorStore: createSupabaseCursorStore(fakeClient) });
  assert.equal(r2[0].forwarded, 0);
  assert.equal(sent.length, 1);
});

test("pollAllTeams tanpa cursorStore: tiap run berdiri sendiri (window saja)", async () => {
  const registry = registryWith([team()]);
  const sent = [];
  const args = {
    registry,
    fetchState: async () => stateWith([["m1", "halo tim", 30_000]]),
    sendTelegram: async (chatId, text) => sent.push({ chatId, text }),
    pollWindowMinutes: 2,
  };
  const r1 = await pollAllTeams(args);
  const r2 = await pollAllTeams(args);
  assert.equal(r1[0].forwarded, 1);
  assert.equal(r2[0].forwarded, 1);
  assert.equal(sent.length, 2);
});
