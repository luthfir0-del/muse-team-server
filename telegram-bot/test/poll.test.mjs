// test/poll.test.mjs — tes lib/pollTeams.js (poll multi-tim) tanpa jaringan.
// Mencakup: peristiwa tiap tim hanya ke chat notifikasi tim itu, digest
// berlabel nama tim, relay EL/[Bot] difilter, tim non-aktif dilewati,
// kegagalan satu tim tidak memblokir tim lain.

import test from "node:test";
import assert from "node:assert/strict";
import { pollAllTeams } from "../lib/pollTeams.js";
import { createRegistry } from "../lib/registry.js";

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

function team(overrides = {}) {
  return {
    id: "raden",
    name: "Tim Raden",
    serverUrl: "https://tim-raden.example",
    apiKey: "kunci-raden",
    fromAgent: "ell",
    agents: ["mas", "mbak", "ell"],
    ownerChatId: "100",
    notifyChatId: "100",
    status: "active",
    ...overrides,
  };
}

function stateFor(teamId, messages) {
  return {
    updated: iso(NOW),
    agents: [
      { id: "mas", name: "Mas", status: "connected", currentActivity: "-", tasksDone: 0, tasksTotal: 0 },
      { id: "mbak", name: "Mbak", status: "connected", currentActivity: "-", tasksDone: 0, tasksTotal: 0 },
    ],
    tasks: [],
    messages: messages.map(([id, from, text, ageMs]) => ({
      id, from, to: "team", text, time: iso(NOW - ageMs),
    })),
    activity: [],
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

test("isolasi poll: peristiwa tim A hanya ke chat A, tim B hanya ke chat B", async () => {
  const sent = [];
  const states = {
    raden: stateFor("raden", [["m1", "mas", "Render selesai", 60_000]]),
    kampung: stateFor("kampung", [["m2", "mbak", "Naskah baru", 60_000]]),
  };
  const results = await pollAllTeams({
    registry: registryWith([
      team(),
      team({ id: "kampung", name: "Tim Kampung", ownerChatId: "200", notifyChatId: "200" }),
    ]),
    fetchState: async (t) => states[t.id],
    sendTelegram: async (chatId, text) => {
      sent.push({ chatId: String(chatId), text });
    },
  });

  assert.equal(results.length, 2);
  assert.equal(sent.length, 2);
  const toRaden = sent.find((s) => s.chatId === "100");
  const toKampung = sent.find((s) => s.chatId === "200");
  assert.ok(toRaden.text.includes("Render selesai"));
  assert.ok(!toRaden.text.includes("Naskah baru"));
  assert.ok(toKampung.text.includes("Naskah baru"));
  assert.ok(!toKampung.text.includes("Render selesai"));
  // Digest berlabel nama tim.
  assert.ok(toRaden.text.includes("[Tim Raden]"));
  assert.ok(toKampung.text.includes("[Tim Kampung]"));
});

test("poll: relay EL dan pesan [Bot] tidak diteruskan; tim non-aktif dilewati", async () => {
  const sent = [];
  const states = {
    raden: stateFor("raden", [
      ["m1", "mas", "Pesan asli", 60_000],
      ["m2", "ell", "[EL] tolong cek", 60_000],
      ["m3", "ell", "[Bot] Bot Telegram terhubung", 60_000],
    ]),
  };
  const results = await pollAllTeams({
    registry: registryWith([
      team(),
      team({ id: "mati", name: "Tim Mati", status: "disabled", ownerChatId: "300", notifyChatId: "300" }),
    ]),
    fetchState: async (t) => states[t.id],
    sendTelegram: async (chatId, text) => {
      sent.push({ chatId: String(chatId), text });
    },
  });

  assert.equal(results.length, 1); // hanya tim aktif
  assert.equal(sent.length, 1);
  assert.ok(sent[0].text.includes("Pesan asli"));
  assert.ok(!sent[0].text.includes("tolong cek"));
  assert.ok(!sent[0].text.includes("Bot Telegram terhubung"));
});

test("poll jendela 1 menit (real-time): peristiwa 90 detik lalu diteruskan, 150 detik lalu dilewati", async () => {
  const sent = [];
  const results = await pollAllTeams({
    registry: registryWith([team()]),
    fetchState: async () =>
      stateFor("raden", [
        ["m1", "mas", "Baru 90 detik", 90_000],
        ["m2", "mbak", "Sudah 150 detik", 150_000],
      ]),
    sendTelegram: async (chatId, text) => {
      sent.push({ chatId: String(chatId), text });
    },
    pollWindowMinutes: 2,
  });
  assert.equal(results[0].forwarded, 1);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].text.includes("Baru 90 detik"));
  assert.ok(!sent[0].text.includes("Sudah 150 detik"));
});

test("poll: tidak ada peristiwa baru -> diam (tidak kirim)", async () => {
  const sent = [];
  const results = await pollAllTeams({
    registry: registryWith([team()]),
    fetchState: async () => stateFor("raden", [["m1", "mas", "Pesan lama", 60 * 60_000]]),
    sendTelegram: async (chatId, text) => {
      sent.push({ chatId, text });
    },
  });
  assert.equal(sent.length, 0);
  assert.equal(results[0].forwarded, 0);
});

test("poll: tim yang gagal dibaca tidak memblokir tim lain", async () => {
  const sent = [];
  const results = await pollAllTeams({
    registry: registryWith([
      team(),
      team({ id: "kampung", name: "Tim Kampung", ownerChatId: "200", notifyChatId: "200" }),
    ]),
    fetchState: async (t) => {
      if (t.id === "raden") throw new Error("server raden mati");
      return stateFor("kampung", [["m2", "mbak", "Naskah baru", 60_000]]);
    },
    sendTelegram: async (chatId, text) => {
      sent.push({ chatId: String(chatId), text });
    },
  });
  assert.equal(results.find((r) => r.teamId === "raden").error, "server raden mati");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, "200");
});

test("poll: filter ?team hanya mem-poll tim itu", async () => {
  const sent = [];
  const results = await pollAllTeams({
    registry: registryWith([
      team(),
      team({ id: "kampung", name: "Tim Kampung", ownerChatId: "200", notifyChatId: "200" }),
    ]),
    fetchState: async (t) => stateFor(t.id, [["m1", "mas", "Pesan", 60_000]]),
    sendTelegram: async (chatId, text) => {
      sent.push({ chatId: String(chatId), text });
    },
    teamFilter: "kampung",
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].teamId, "kampung");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, "200");
});
