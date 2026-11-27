// test/notify.test.mjs — tes endpoint push POST /api/notify tanpa jaringan.
// Mencakup: verifikasi HMAC, normalisasi peristiwa, routing ke tim yang
// benar, dedup vs cursor (push kedua tidak terkirim lagi), filter echo,
// tim tak dikenal / non-aktif, tim tanpa chat notifikasi.

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createNotifyHandler } from "../api/notify.js";
import { isPushEcho, normalizePushEvent, signPushPayload, verifyPushSignature } from "../lib/notify.js";
import { createMemoryCursorStore } from "../lib/cursor.js";

const SECRET = "rahasia-push-uji";
const NOW = Date.now();

const TEAMS = {
  raden: { id: "raden", name: "Tim Raden", status: "active", notifyChatId: "100" },
  "tanpa-chat": { id: "tanpa-chat", name: "Tim Tanpa Chat", status: "active", notifyChatId: "" },
  pending: { id: "pending", name: "Tim Pending", status: "pending", notifyChatId: "100" },
};

function makeHandler(secret = SECRET) {
  const sent = [];
  const handler = createNotifyHandler({
    registry: { getTeam: async (id) => TEAMS[id] || null },
    sendTelegram: async (chatId, text) => sent.push({ chatId, text }),
    cursorStore: createMemoryCursorStore(),
    botNotifySecret: secret,
  });
  return { handler, sent };
}

function fakeReq({ method = "POST", headers = {}, body = "" }) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = headers;
  req.url = "/api/notify";
  process.nextTick(() => {
    if (body) req.emit("data", Buffer.from(body, "utf8"));
    req.emit("end");
  });
  return req;
}

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (obj) => {
    res.body = obj;
    return res;
  };
  return res;
}

async function call(handler, { body, secret = SECRET, signature } = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const sig = signature !== undefined ? signature : signPushPayload(secret, raw);
  const req = fakeReq({ headers: { "x-bot-signature": sig }, body: raw });
  const res = fakeRes();
  await handler(req, res);
  return res;
}

const pushBody = (teamId, type, event) => ({ teamId, type, event });

// --- Unit: signature ------------------------------------------------------

test("verifyPushSignature: benar -> true, salah -> false", () => {
  const raw = JSON.stringify({ teamId: "raden" });
  const good = signPushPayload(SECRET, raw);
  assert.equal(verifyPushSignature(SECRET, raw, good), true);
  assert.equal(verifyPushSignature(SECRET, raw, signPushPayload("secret-lain", raw)), false);
  assert.equal(verifyPushSignature(SECRET, JSON.stringify({ teamId: "lain" }), good), false);
  assert.equal(verifyPushSignature(SECRET, raw, undefined), false);
  assert.equal(verifyPushSignature(SECRET, raw, "bukan-format"), false);
  assert.equal(verifyPushSignature("", raw, good), false);
});

// --- Unit: normalisasi + echo ----------------------------------------------

test("normalizePushEvent: pesan + aktivitas, terima epoch ms dan ISO", () => {
  const m = normalizePushEvent("message", { kind: "message", id: "abc", time: NOW, from: "mas", to: "team", text: "halo" });
  assert.deepEqual(m, { kind: "message", id: "abc", time: NOW, from: "mas", to: "team", text: "halo" });
  const a = normalizePushEvent("activity", { kind: "activity", time: new Date(NOW).toISOString(), agent: "mbak", event: "update status: kerja" });
  assert.equal(a.kind, "activity");
  assert.equal(a.time, NOW);
  assert.equal(normalizePushEvent("message", { kind: "message", time: NOW, from: "mas" }), null);
  assert.equal(normalizePushEvent("message", { kind: "activity", time: NOW, agent: "mas", event: "x" }), null);
  assert.equal(normalizePushEvent("pesan", null), null);
  assert.equal(normalizePushEvent("message", { kind: "message", time: "bukan-waktu", from: "mas", text: "x" }), null);
});

test("isPushEcho: prefix [EL] dan [Bot] dikenali", () => {
  assert.equal(isPushEcho("[EL] halo"), true);
  assert.equal(isPushEcho("[Bot] halo"), true);
  assert.equal(isPushEcho("halo biasa"), false);
  assert.equal(isPushEcho(null), false);
});

// --- Handler ---------------------------------------------------------------

test("handler: GET ditolak 405; tanpa secret 500", async () => {
  const { handler } = makeHandler();
  const getReq = fakeReq({ method: "GET", body: "" });
  const getRes = fakeRes();
  await handler(getReq, getRes);
  assert.equal(getRes.statusCode, 405);

  const { handler: noSecret } = makeHandler("");
  const res = await call(noSecret, { body: pushBody("raden", "message", { kind: "message", id: "m1", time: NOW, from: "mas", text: "x" }) });
  assert.equal(res.statusCode, 500);
});

test("handler: signature salah -> 401, body bukan JSON -> 400", async () => {
  const { handler } = makeHandler();
  const bad = await call(handler, {
    body: pushBody("raden", "message", { kind: "message", id: "m1", time: NOW, from: "mas", text: "x" }),
    signature: "sha256=0000000000000000000000000000000000000000000000000000000000000000",
  });
  assert.equal(bad.statusCode, 401);

  const notJson = await call(handler, { body: "{bukan json" });
  assert.equal(notJson.statusCode, 400);
});

test("handler: push pesan diteruskan sekali, push ulang di-dedup", async () => {
  const { handler, sent } = makeHandler();
  const ev = { kind: "message", id: "m1", time: NOW, from: "mas", to: "team", text: "halo tim" };

  const r1 = await call(handler, { body: pushBody("raden", "message", ev) });
  assert.equal(r1.statusCode, 200);
  assert.equal(r1.body.forwarded, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, "100");
  assert.ok(sent[0].text.includes("[Tim Raden]"));
  assert.ok(sent[0].text.includes("halo tim"));

  // Push yang sama persis lagi -> dedup, tidak terkirim.
  const r2 = await call(handler, { body: pushBody("raden", "message", ev) });
  assert.equal(r2.statusCode, 200);
  assert.equal(r2.body.forwarded, 0);
  assert.equal(r2.body.deduped, true);
  assert.equal(sent.length, 1);

  // Peristiwa baru (lebih baru) tetap diteruskan.
  const r3 = await call(handler, {
    body: pushBody("raden", "message", { kind: "message", id: "m2", time: NOW + 1000, from: "mbak", to: "team", text: "lanjut" }),
  });
  assert.equal(r3.body.forwarded, 1);
  assert.equal(sent.length, 2);

  // Peristiwa lama (sudah lewat cursor) tidak diteruskan lagi.
  const r4 = await call(handler, { body: pushBody("raden", "message", ev) });
  assert.equal(r4.body.forwarded, 0);
  assert.equal(r4.body.deduped, true);
  assert.equal(sent.length, 2);
});

test("handler: tim tak dikenal / non-aktif -> 404, teamId hilang -> 400", async () => {
  const { handler, sent } = makeHandler();
  const ev = { kind: "message", id: "m1", time: NOW, from: "mas", text: "x" };
  const r1 = await call(handler, { body: pushBody("tim-asing", "message", ev) });
  assert.equal(r1.statusCode, 404);
  const r2 = await call(handler, { body: pushBody("pending", "message", ev) });
  assert.equal(r2.statusCode, 404);
  const r3 = await call(handler, { body: { type: "message", event: ev } });
  assert.equal(r3.statusCode, 400);
  assert.equal(sent.length, 0);
});

test("handler: pesan echo [EL] tidak dipantulkan", async () => {
  const { handler, sent } = makeHandler();
  const r = await call(handler, {
    body: pushBody("raden", "message", { kind: "message", id: "m9", time: NOW, from: "ell", text: "[EL] jangan pantul" }),
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.forwarded, 0);
  assert.equal(r.body.reason, "echo");
  assert.equal(sent.length, 0);
});

test("handler: tim tanpa notifyChatId -> 0, cursor tidak maju", async () => {
  const { handler, sent } = makeHandler();
  const r = await call(handler, {
    body: pushBody("tanpa-chat", "message", { kind: "message", id: "m1", time: NOW, from: "mas", text: "x" }),
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.forwarded, 0);
  assert.equal(r.body.reason, "no-notify-chat");
  assert.equal(sent.length, 0);
});

test("handler: push aktivitas diteruskan dengan format aktivitas", async () => {
  const { handler, sent } = makeHandler();
  const r = await call(handler, {
    body: pushBody("raden", "activity", { kind: "activity", time: NOW, agent: "mbak", event: "Mbak update status: render" }),
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.forwarded, 1);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].text.includes("Mbak"));
  assert.ok(sent[0].text.includes("render"));
});
