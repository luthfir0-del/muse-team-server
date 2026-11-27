// test/diff.test.mjs — tes lib/diff.js dengan state sintetis (tanpa jaringan).
import test from "node:test";
import assert from "node:assert/strict";
import { findAnomalies, newEventsSince } from "../lib/diff.js";

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

function sampleState() {
  return {
    updated: iso(NOW),
    agents: [
      { id: "mas", name: "Mas", status: "connected", currentActivity: "Render", tasksDone: 1, tasksTotal: 2 },
      { id: "mbak", name: "Mbak", status: "connected", currentActivity: "Nulis", tasksDone: 0, tasksTotal: 1 },
      { id: "ell", name: "Ell", status: "offline", currentActivity: "-", tasksDone: 0, tasksTotal: 0 },
    ],
    tasks: [
      { id: "t1", agent: "mas", title: "Render Part 4", status: "in_progress", time: "19:00" },
      { id: "t2", agent: "mbak", title: "Naskah baru", status: "blocked", time: "—" },
    ],
    messages: [
      { id: "m1", from: "mas", to: "team", text: "Render selesai", time: iso(NOW - 60_000) },
      { id: "m2", from: "ell", to: "team", text: "[EL] tolong cek ini", time: iso(NOW - 60_000) },
      { id: "m3", from: "mbak", to: "team", text: "Pesan lama", time: iso(NOW - 60 * 60_000) },
    ],
    activity: [
      { agent: "mas", event: 'Mas mengubah status "Render Part 4" → done', time: iso(NOW - 120_000) },
      { agent: "ell", event: "Ell mengirim pesan ke ruang tim", time: iso(NOW - 60_000) },
      { agent: "mas", event: "Mas update status: Render jalan", time: iso(NOW - 30 * 60_000) },
    ],
  };
}

test("pesan baru diteruskan, relay EL dilewati, pesan lama dilewati", () => {
  const events = newEventsSince(sampleState(), NOW - 7 * 60_000, { botFromAgent: "ell" });
  const kinds = events.map((e) => `${e.kind}:${e.id || e.event}`);
  assert.ok(kinds.includes("message:m1"), "m1 harus diteruskan");
  assert.ok(!kinds.some((k) => k.includes("m2")), "m2 (relay EL) harus dilewati");
  assert.ok(!kinds.some((k) => k.includes("m3")), "m3 (lama) harus dilewati");
});

test("log aktivitas: ubah tugas diteruskan, 'mengirim pesan' dilewati, log lama dilewati", () => {
  const events = newEventsSince(sampleState(), NOW - 7 * 60_000, { botFromAgent: "ell" });
  const activity = events.filter((e) => e.kind === "activity");
  assert.equal(activity.length, 1);
  assert.match(activity[0].event, /mengubah status/);
});

test("peristiwa urut kronologis", () => {
  const events = newEventsSince(sampleState(), NOW - 7 * 60_000, { botFromAgent: "ell" });
  for (let i = 1; i < events.length; i++) {
    assert.ok(events[i].time >= events[i - 1].time, "harus urut naik");
  }
});

test("anomali: agent offline + tugas blocked terdeteksi", () => {
  const anomalies = findAnomalies(sampleState());
  assert.equal(anomalies.length, 2);
  assert.ok(anomalies.some((a) => a.includes("Ell") && a.includes("belum terhubung")));
  assert.ok(anomalies.some((a) => a.includes("Naskah baru")));
});
