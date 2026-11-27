// test/format.test.mjs — tes format ringkas EL (28 Nov 2026): notifikasi
// aktivitas TIDAK BOLEH lagi membuang seluruh teks status (punya Mas bisa
// 6000+ karakter). Yang dikirim hanya nama agent, lalu satu baris per
// tugas (+ info terbaru, maks ~200 karakter) - link1 - link2.

import test from "node:test";
import assert from "node:assert/strict";
import {
  compactActivityText,
  extractLinks,
  formatEvent,
  formatEventBody,
  formatStatus,
  formatTasks,
  groupEventParts,
} from "../lib/format.js";

const LONG_STATUS =
  "Mas update status: Stick Mints — 3 sampel konten: rakitan ulang selesai ~04:36 WIB " +
  "(3 final mp4 ditulis ulang; klip fabel 5/6 + fabel-silent selesai); QC stills + transkrip " +
  "Whisper 3 video di-generate ulang ~04:37-04:38 WIB (money 7 kalimat, naskah cocok, 0 kata " +
  "Inggris); verdict QC BELUM ada — Stick Mints — 3 sampel konten: QC file final DIMULAI " +
  "~04:21 WIB (stills QC + transkrip Whisper 3 video selesai ~04:23 WIB — money 7 kalimat, " +
  "komedi 4, fabel 6, naskah cocok, 0 kata Inggris); komedi final di-render ulang (retry " +
  "selesai 04:21:02 WIB, tetap 19,1 dtk); verdict QC BELUM ada — Stick Mints — 3 sampel " +
  "konten: video final TERAKIT ~04:17 WIB (money 22,7 dtk, komedi 19,1 dtk, fabel 31,7 dtk; " +
  "1080x1920/30fps, mp4 ada di disk); rakitan MASIH BERJALAN, QC BELUM ada — belum ada video " +
  "final terverifikasi — " +
  "x".repeat(5000);

test("status panjang dipadatkan: header nama agent + ~200 karakter info terbaru", () => {
  const out = formatEvent({ kind: "activity", agent: "mas", event: LONG_STATUS, time: Date.now() });
  const lines = out.split("\n");
  assert.equal(lines[0], "<b>Mas</b>");
  assert.ok(lines[1].startsWith("Stick Mints — 3 sampel konten: rakitan ulang selesai"));
  assert.ok(lines[1].length <= 230, `baris tugas ${lines[1].length} karakter, harusnya <= 230`);
  assert.ok(!out.includes("TERAKIT"), "pengulangan riwayat lama tidak boleh ikut terkirim");
  assert.ok(!out.includes("x".repeat(100)), "teks bantalan tidak boleh ikut terkirim");
});

test("extractLinks: URL penuh + domain telanjang dinormalisasi, dedup, maks 3", () => {
  const links = extractLinks(
    "Tayang! Live: facebook.com/reel/1091848273854931/ dan https://www.youtube.com/shorts/Bx3453reFPo " +
      "juga facebook.com/reel/1091848273854931/ lalu instagram.com/p/DgALgmvsgcn/ plus tiktok.com/@a/video/1."
  );
  assert.deepEqual(links, [
    "https://www.youtube.com/shorts/Bx3453reFPo",
    "https://facebook.com/reel/1091848273854931/",
    "https://instagram.com/p/DgALgmvsgcn/",
  ]);
});

test("peristiwa ubah tugas: hanya judul tugas, tanpa pembungkus", () => {
  const out = formatEvent({
    kind: "activity",
    agent: "mas",
    event: 'Mas mengubah tugas "Fanpage baru mirip \'Stick Mints\' — stickman money-mindset"',
    time: Date.now(),
  });
  assert.equal(
    out,
    "<b>Mas</b>\nFanpage baru mirip 'Stick Mints' — stickman money-mindset"
  );
});

test("aktivitas ber-link: link menempel di baris tugas dipisah ' - '", () => {
  const out = formatEvent({
    kind: "activity",
    agent: "mas",
    event: "Mas update status: Perjalanan Akun Ep12 — tayang 19:00 WIB. Live: facebook.com/reel/1091848273854931/",
    time: Date.now(),
  });
  assert.ok(
    out.includes(" - https://facebook.com/reel/1091848273854931/"),
    `link harus menempel di baris tugas: ${out}`
  );
});

test("pesan chat tidak berubah format (tetap ada tujuan + jam)", () => {
  const out = formatEvent({
    kind: "message",
    from: "mas",
    to: "team",
    text: "Halo tim, Ep12 sudah tayang.",
    time: Date.now(),
  });
  assert.match(out, /^💬 <b>Mas<\/b> → ruang tim \(/);
  assert.ok(out.includes("Halo tim, Ep12 sudah tayang."));
});

test("groupEventParts: aktivitas berurutan satu agent berbagi satu header", () => {
  const now = Date.now();
  const team = { id: "raden", name: "Tim Raden" };
  const parts = groupEventParts(
    [
      { kind: "activity", agent: "mas", event: "Mas update status: Tugas A selesai.", time: now },
      { kind: "activity", agent: "mas", event: "Mas update status: Tugas B mulai.", time: now + 1 },
      { kind: "activity", agent: "mbak", event: "Mbak update status: Tugas C selesai.", time: now + 2 },
    ],
    team
  );
  assert.equal(parts.length, 2);
  assert.equal(parts[0], "[Tim Raden] <b>Mas</b>\nTugas A selesai.\nTugas B mulai.");
  assert.equal(parts[1], "[Tim Raden] <b>Mbak</b>\nTugas C selesai.");
});

test("groupEventParts: pesan chat memutus grup aktivitas", () => {
  const now = Date.now();
  const team = { id: "raden", name: "Tim Raden" };
  const parts = groupEventParts(
    [
      { kind: "activity", agent: "mas", event: "Mas update status: Tugas A selesai.", time: now },
      { kind: "message", from: "mbak", to: "team", text: "Siap.", time: now + 1 },
      { kind: "activity", agent: "mas", event: "Mas update status: Tugas B mulai.", time: now + 2 },
    ],
    team
  );
  assert.equal(parts.length, 3);
  assert.ok(parts[0].startsWith("[Tim Raden] <b>Mas</b>\nTugas A selesai."));
  assert.ok(parts[1].includes("💬 <b>Mbak</b>"));
  assert.ok(parts[2].startsWith("[Tim Raden] <b>Mas</b>\nTugas B mulai."));
});

test("formatTasks: link dari detail menempel di baris tugas", () => {
  const state = {
    agents: [{ id: "mas", name: "Mas" }],
    tasks: [
      {
        id: "t1",
        agent: "mas",
        title: "Perjalanan Akun Ep12 — tayang 19:00 WIB",
        detail: "Tayang 19:37 WIB. Live: facebook.com/reel/1091848273854931/",
        status: "done",
        time: "—",
      },
      { id: "t2", agent: "mas", title: "Tugas tanpa link", detail: "", status: "pending", time: "—" },
    ],
  };
  const out = formatTasks(state, { id: "raden", name: "Tim Raden" });
  assert.ok(out.includes("Perjalanan Akun Ep12 — tayang 19:00 WIB - https://facebook.com/reel/1091848273854931/"));
  assert.ok(out.includes("Tugas tanpa link"));
  assert.ok(!out.includes("Tugas tanpa link - http"));
});

test("formatStatus: statusDetail panjang dipadatkan, bukan dinding teks", () => {
  const state = {
    updated: new Date().toISOString(),
    agents: [
      {
        id: "mas",
        name: "Mas",
        status: "connected",
        tasksDone: 1,
        tasksTotal: 2,
        statusDetail: LONG_STATUS.replace(/^Mas update status: /, ""),
      },
    ],
    tasks: [],
  };
  const out = formatStatus(state, { id: "raden", name: "Tim Raden" });
  assert.ok(out.length < 800, `status ${out.length} karakter, harusnya < 800`);
  assert.ok(!out.includes("TERAKIT"), "pengulangan riwayat tidak boleh ikut");
});

test("compactActivityText: teks pendek tidak berubah", () => {
  assert.equal(compactActivityText("Tugas A selesai."), "Tugas A selesai.");
  assert.equal(
    compactActivityText('Mas mengubah tugas "Judul tugas"'),
    "Judul tugas"
  );
});

test("formatEventBody dipakai digest: tanpa header agent", () => {
  const body = formatEventBody({
    kind: "activity",
    agent: "mas",
    event: "Mas update status: Tugas A selesai.",
    time: Date.now(),
  });
  assert.equal(body, "Tugas A selesai.");
});
