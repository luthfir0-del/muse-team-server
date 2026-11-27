// test/telegram.test.mjs — tes lib/telegram.js (kirim ke Bot API) tanpa jaringan.
// Mencakup: pesan pendek dikirim sekali, pesan panjang dipecah per baris
// (tiap potongan <= 4096 karakter, batas Telegram), baris tunggal yang
// sangat panjang dipotong keras, dan potongan non-terakhir ditandai
// "(bersambung…)".

import test from "node:test";
import assert from "node:assert/strict";

// Token dibaca config saat modul telegram.js pertama di-import, jadi set
// env dulu sebelum dynamic import pertama.
process.env.TELEGRAM_BOT_TOKEN = "test-token";

let telegram = null;
async function loadTelegram() {
  if (!telegram) telegram = await import("../lib/telegram.js");
  return telegram;
}

function stubFetch(calls) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  return () => {
    globalThis.fetch = orig;
  };
}

test("splitLongText: teks pendek tidak dipecah", async () => {
  const { splitLongText } = await loadTelegram();
  const parts = splitLongText("halo tim");
  assert.deepEqual(parts, ["halo tim"]);
});

test("splitLongText: teks panjang dipecah per baris, tiap potongan <= 4000", async () => {
  const { splitLongText, MAX_TELEGRAM_TEXT } = await loadTelegram();
  const line = "x".repeat(1500);
  const text = [line, line, line, line].join("\n"); // 6003 karakter
  const parts = splitLongText(text);
  assert.ok(parts.length >= 2);
  for (const p of parts) assert.ok(p.length <= MAX_TELEGRAM_TEXT, `potongan ${p.length} > ${MAX_TELEGRAM_TEXT}`);
  assert.equal(parts.join("\n"), text);
});

test("splitLongText: satu baris 4.778 karakter (update status Mas) dipotong keras", async () => {
  const { splitLongText, MAX_TELEGRAM_TEXT } = await loadTelegram();
  const text = "y".repeat(4778);
  const parts = splitLongText(text);
  assert.ok(parts.length >= 2);
  for (const p of parts) assert.ok(p.length <= MAX_TELEGRAM_TEXT);
  assert.equal(parts.join(""), text);
});

test("sendTelegram: pesan 4.778 karakter terkirim sebagai 2 pesan, tiap pesan < 4096", async () => {
  const { sendTelegram } = await loadTelegram();
  const calls = [];
  const restore = stubFetch(calls);
  try {
    await sendTelegram("100", "z".repeat(4778));
  } finally {
    restore();
  }
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.ok(c.body.text.length <= 4096, `pesan ${c.body.text.length} > 4096`);
    assert.equal(c.body.chat_id, "100");
    assert.equal(c.body.parse_mode, "HTML");
  }
  assert.ok(calls[0].body.text.includes("(bersambung…)"));
  assert.ok(!calls[1].body.text.includes("(bersambung…)"));
});

test("sendTelegram: pesan pendek terkirim sekali tanpa penanda", async () => {
  const { sendTelegram } = await loadTelegram();
  const calls = [];
  const restore = stubFetch(calls);
  try {
    await sendTelegram("100", "halo tim");
  } finally {
    restore();
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.text, "halo tim");
});
