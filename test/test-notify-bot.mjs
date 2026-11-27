// Tes push server -> bot Telegram (jalankan: npm test).
// Unit: notify-bot.js (signature, bentuk peristiwa, notifier mati/tanpa
// konfigurasi tidak pernah throw). E2E: menyalakan server sendiri di port
// tes dengan STATE_FILE sementara + stub HTTP sebagai "bot", lalu POST
// /api/messages, /api/status, /api/tasks dan memastikan stub menerima push
// yang benar (teamId, type, event, signature HMAC valid) — dan pesan
// relay [EL] TIDAK di-push. Tidak menyentuh data/state.json asli dan
// tidak menyentuh server yang jalan. Keluar 0 kalau semua lolos.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  activityEvent,
  createNotifier,
  isEchoMessage,
  messageEvent,
  signPayload,
} from "../notify-bot.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PORT = 3458;
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_STATE = path.join(os.tmpdir(), "muse-team-server-test-notify-state.json");
const SECRET = "test-notify-secret";

const KEYS = { mas: "test-mas-key", mbak: "test-mbak-key", ell: "test-ell-key" };

let pass = 0;
let fail = 0;
function check(name, ok, extra = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name} ${extra}`);
  }
}

async function waitHealth(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return true;
    } catch {
      /* belum nyala */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

// --- Stub "bot": tangkap push, verifikasi signature HMAC -------------------
function startStubBot() {
  const pushes = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      let body = null;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        /* abaikan */
      }
      const sig = req.headers["x-bot-signature"];
      const valid = typeof sig === "string" && sig === signPayload(SECRET, raw);
      pushes.push({ path: req.url, signatureValid: valid, body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, pushes }));
  });
}

async function main() {
  // --- 1. Unit: bentuk + signature ----------------------------------------
  {
    const msg = { id: "abc-1", time: "2026-11-27T07:00:00.000Z", from: "mas", to: "team", text: "halo" };
    const ev = messageEvent(msg);
    check("messageEvent: bentuk poll (time epoch ms)", ev.kind === "message" && ev.time === Date.parse(msg.time) && ev.id === "abc-1" && ev.text === "halo");
    const act = activityEvent({ agent: "mbak", event: "Mbak update status: kerja", time: "2026-11-27T07:01:00.000Z" });
    check("activityEvent: bentuk poll", act.kind === "activity" && act.agent === "mbak" && act.time === Date.parse("2026-11-27T07:01:00.000Z"));
    check("isEchoMessage: [EL]/[Bot] dikenali", isEchoMessage("[EL] x") && isEchoMessage("[Bot] x") && !isEchoMessage("halo"));
    const sig = signPayload(SECRET, "isi-body");
    check("signPayload: deterministik + format sha256=", sig.startsWith("sha256=") && sig === signPayload(SECRET, "isi-body"));
    check("signPayload: beda secret/body -> beda signature", sig !== signPayload("lain", "isi-body") && sig !== signPayload(SECRET, "lain"));
  }

  // --- 2. Unit: notifier ---------------------------------------------------
  {
    const disabled = createNotifier({ url: "", secret: "" });
    check("notifier non-aktif tanpa URL/secret", disabled.enabled === false);
    let fetchCalled = false;
    const r1 = await disabled.notify({ type: "message", event: {} });
    check("notifier non-aktif: notify() tidak memanggil fetch", r1.ok === false && r1.reason === "disabled" && !fetchCalled);

    const noSecret = createNotifier({ url: "http://127.0.0.1:9/api/notify", secret: "", fetchImpl: async () => { fetchCalled = true; return { ok: true }; } });
    check("notifier non-aktif tanpa secret", noSecret.enabled === false);

    let captured = null;
    const okFetch = createNotifier({
      url: "http://127.0.0.1:9/api/notify",
      secret: SECRET,
      teamId: "raden",
      fetchImpl: async (url, opts) => {
        captured = { url, headers: opts.headers, body: opts.body };
        return { ok: true, status: 200 };
      },
    });
    const r2 = await okFetch.notify({ type: "message", event: { kind: "message", id: "m1", time: 1, from: "mas", to: "team", text: "halo" } });
    const parsed = JSON.parse(captured.body);
    check("notifier: POST JSON teamId+type+event", r2.ok === true && parsed.teamId === "raden" && parsed.type === "message" && parsed.event.text === "halo");
    check(
      "notifier: header X-Bot-Signature = HMAC body",
      captured.headers["X-Bot-Signature"] === signPayload(SECRET, captured.body)
    );

    const down = createNotifier({
      url: "http://127.0.0.1:9/api/notify",
      secret: SECRET,
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    let threw = false;
    let r3 = null;
    try {
      r3 = await down.notify({ type: "message", event: {} });
    } catch {
      threw = true;
    }
    check("notifier: bot down -> { ok:false } tanpa throw", !threw && r3 && r3.ok === false);

    const http500 = createNotifier({
      url: "http://127.0.0.1:9/api/notify",
      secret: SECRET,
      fetchImpl: async () => ({ ok: false, status: 500 }),
    });
    const r4 = await http500.notify({ type: "message", event: {} });
    check("notifier: bot jawab 500 -> { ok:false, http-500 }", r4.ok === false && r4.reason === "http-500");

    // Timeout: server sungguhan yang tidak pernah menjawab (socket-nya
    // yang menjaga event loop tetap hidup — AbortSignal.timeout memakai
    // timer unrefed, jadi stub fetch tanpa socket membuat proses keluar
    // sebelum abort; di produksi fetch sungguhan selalu punya socket).
    const slowServer = http.createServer(() => {
      /* sengaja tidak pernah menjawab */
    });
    await new Promise((r) => slowServer.listen(0, "127.0.0.1", r));
    const slow = createNotifier({
      url: `http://127.0.0.1:${slowServer.address().port}/api/notify`,
      secret: SECRET,
      timeoutMs: 100,
    });
    const t0 = Date.now();
    const r5 = await slow.notify({ type: "message", event: {} });
    check("notifier: timeout -> { ok:false } dalam ~100ms", r5.ok === false && Date.now() - t0 < 2000);
    slowServer.close();
  }

  // --- 3. E2E: server sungguhan -> stub bot --------------------------------
  const stub = await startStubBot();
  fs.copyFileSync(path.join(ROOT, "data", "seed.json"), TEST_STATE);
  const child = spawn("node", ["server.js"], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      PORT: String(PORT),
      STATE_FILE: TEST_STATE,
      SUPABASE_URL: "",
      SUPABASE_SERVICE_KEY: "",
      VERCEL: "",
      MAS_API_KEY: KEYS.mas,
      MBAK_API_KEY: KEYS.mbak,
      ELL_API_KEY: KEYS.ell,
      BOT_NOTIFY_URL: `http://127.0.0.1:${stub.port}/api/notify`,
      BOT_NOTIFY_SECRET: SECRET,
      TEAM_ID: "raden",
    },
  });
  let serverErr = "";
  child.stderr.on("data", (d) => {
    serverErr += d.toString();
  });

  try {
    const up = await waitHealth();
    check("e2e: server tes nyala (/health)", up, serverErr.slice(-500));
    if (!up) throw new Error("server tidak nyala");

    const post = async (pathName, key, body) => {
      const r = await fetch(`${BASE}${pathName}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      });
      return { status: r.status, json: await r.json() };
    };

    // Pesan -> push message.
    const m1 = await post("/api/messages", KEYS.ell, { to: "team", text: "halo tim" });
    check("e2e: POST /api/messages 200", m1.status === 200 && m1.json.ok === true);
    check(
      "e2e: push message diterima stub (teamId/type/event/signature)",
      stub.pushes.length === 1 &&
        stub.pushes[0].signatureValid === true &&
        stub.pushes[0].body.teamId === "raden" &&
        stub.pushes[0].body.type === "message" &&
        stub.pushes[0].body.event.kind === "message" &&
        stub.pushes[0].body.event.from === "ell" &&
        stub.pushes[0].body.event.text === "halo tim" &&
        typeof stub.pushes[0].body.event.time === "number"
    );

    // Status -> push activity.
    const s1 = await post("/api/status", KEYS.mas, { activity: "render video", detail: "batch 27" });
    check("e2e: POST /api/status 200", s1.status === 200 && s1.json.ok === true);
    check(
      "e2e: push activity update status diterima",
      stub.pushes.length === 2 &&
        stub.pushes[1].signatureValid === true &&
        stub.pushes[1].body.type === "activity" &&
        stub.pushes[1].body.event.kind === "activity" &&
        stub.pushes[1].body.event.agent === "mas" &&
        stub.pushes[1].body.event.event.includes("update status")
    );

    // Tugas baru -> push activity.
    const t1 = await post("/api/tasks", KEYS.mbak, { title: "Tugas uji push", detail: "cek" });
    check("e2e: POST /api/tasks (baru) 200", t1.status === 200 && t1.json.ok === true && Boolean(t1.json.task?.id));
    check(
      "e2e: push activity tambah tugas diterima",
      stub.pushes.length === 3 &&
        stub.pushes[2].body.type === "activity" &&
        stub.pushes[2].body.event.event.includes("menambah tugas")
    );

    // Ubah status tugas -> push activity.
    const taskId = t1.json.task.id;
    const t2 = await post("/api/tasks", KEYS.mbak, { id: taskId, status: "done" });
    check("e2e: POST /api/tasks (status) 200", t2.status === 200 && t2.json.ok === true);
    check(
      "e2e: push activity ubah status diterima",
      stub.pushes.length === 4 &&
        stub.pushes[3].body.type === "activity" &&
        stub.pushes[3].body.event.event.includes("mengubah status")
    );

    // Pesan relay [EL] -> TIDAK di-push (anti-pantul).
    const m2 = await post("/api/messages", KEYS.ell, { to: "team", text: "[EL] jangan pantul" });
    check("e2e: POST pesan [EL] tetap 200", m2.status === 200 && m2.json.ok === true);
    check("e2e: pesan [EL] tidak di-push", stub.pushes.length === 4);
  } finally {
    child.kill();
    await new Promise((r) => child.on("exit", r));
    stub.server.close();
    try {
      fs.unlinkSync(TEST_STATE);
    } catch {
      /* abaikan */
    }
  }

  console.log(`\nnotify-bot: ${pass} lolos, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
