// muse-team-server — satu server bersama untuk tiga akun Muse (Mas, Mbak, Ell).
// Tiap agent join sendiri lewat konektor MCP + kunci API-nya, lalu update
// status dan tugasnya SENDIRI. Server tidak pernah menjawab atas nama agent lain.
//
// Jalankan:  npm install && npm start
// MCP:       POST /mcp  (streamable HTTP, auth: Bearer <kunci-agent>)
// REST:      GET  /api/state  (publik, baca saja)
//            POST /api/status | /api/tasks | /api/messages  (auth: Bearer / X-API-Key)
// Dashboard: GET  /

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createStateStore, createSupabaseClient } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, "data");
// STATE_FILE bisa di-override lewat env (dipakai tes otomatis supaya tidak
// mengotori data/state.json). Default: data/state.json di samping seed.json.
const STATE_FILE = process.env.STATE_FILE || path.join(DATA_DIR, "state.json");
const SEED_FILE = path.join(DATA_DIR, "seed.json");
const PUBLIC_DIR = path.join(__dirname, "public");

// ---------------------------------------------------------------- kunci API
// Satu kunci = satu agent. Kunci TIDAK PERNAH ditulis di repo — hanya lewat env.
// Kalau env kosong (jalan lokal untuk tes), dipakai kunci dev dan server
// akan mencetak peringatan besar di console. JANGAN pakai kunci dev di publik.
const USING_DEV_KEYS = !process.env.MAS_API_KEY && !process.env.MBAK_API_KEY && !process.env.ELL_API_KEY;
const API_KEYS = {
  mas: process.env.MAS_API_KEY || "dev-mas-key",
  mbak: process.env.MBAK_API_KEY || "dev-mbak-key",
  ell: process.env.ELL_API_KEY || "dev-ell-key",
};
const AGENT_IDS = ["mas", "mbak", "ell"];
const TASK_STATUSES = ["done", "in_progress", "pending", "ready", "blocked", "scheduled"];

function agentFromKey(key) {
  if (!key) return null;
  for (const id of AGENT_IDS) if (API_KEYS[id] === key) return id;
  return null;
}

function authAgent(req) {
  const auth = req.headers.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const headerKey = req.headers["x-api-key"];
  const key = bearer || (Array.isArray(headerKey) ? headerKey[0] : headerKey) || null;
  return key ? agentFromKey(key) : null;
}

// ---------------------------------------------------------------- state
// Penyimpanan lewat store.js: Supabase kalau SUPABASE_URL +
// SUPABASE_SERVICE_KEY di-set (state awet walau restart di hosting gratis),
// kalau tidak, file lokal data/state.json seperti sebelumnya.
const store = createStateStore({
  stateFile: STATE_FILE,
  seedFile: SEED_FILE,
  supabaseClient: createSupabaseClient(process.env),
});

let state = await store.load();

function logActivity(agentId, event) {
  state.activity.push({ agent: agentId, event, time: new Date().toISOString() });
  if (state.activity.length > 300) state.activity = state.activity.slice(-300);
}

function agentRow(agentId) {
  return state.agents.find((a) => a.id === agentId);
}

function publicState() {
  return {
    version: state.version,
    updated: state.updated,
    agents: state.agents.map((a) => {
      const tasks = state.tasks.filter((t) => t.agent === a.id);
      return {
        ...a,
        tasksDone: tasks.filter((t) => t.status === "done").length,
        tasksTotal: tasks.length,
      };
    }),
    tasks: state.tasks,
    messages: state.messages.slice(-100),
    activity: state.activity.slice(-100),
  };
}

function touch() {
  state.updated = new Date().toISOString();
  // persist() menulis file lokal dulu (sinkron — error disk dilempar seperti
  // dulu) lalu upsert ke Supabase di latar belakang (gagalnya hanya dicatat).
  void store.persist(state);
}

// ------------------------------------------------------- logika bisnis (dipakai MCP + REST)
function doUpdateStatus(agentId, { activity, detail }) {
  const row = agentRow(agentId);
  if (activity !== undefined) row.currentActivity = activity;
  if (detail !== undefined) row.statusDetail = detail;
  row.status = "connected";
  if (!row.connectedAt) row.connectedAt = new Date().toISOString();
  logActivity(agentId, `${row.name} update status: ${row.currentActivity}`);
  touch();
  return { ok: true, agent: publicState().agents.find((a) => a.id === agentId) };
}

function doUpsertTask(agentId, { id, title, detail, time, status }) {
  if (id) {
    const existing = state.tasks.find((t) => t.id === id);
    if (existing) {
      if (existing.agent !== agentId) {
        throw new Error(`Tugas "${id}" milik ${existing.agent}, bukan ${agentId}. Agent hanya boleh mengubah tugasnya sendiri.`);
      }
      if (title !== undefined) existing.title = title;
      if (detail !== undefined) existing.detail = detail;
      if (time !== undefined) existing.time = time;
      if (status !== undefined) existing.status = status;
      logActivity(agentId, `${agentRow(agentId).name} mengubah tugas "${existing.title}"`);
      touch();
      return { ok: true, task: existing };
    }
  }
  const task = {
    agent: agentId,
    detail: detail || "",
    id: id || `${agentId}-${Date.now().toString(36)}`,
    status: status || "pending",
    time: time || "—",
    title: title || "(tanpa judul)",
  };
  state.tasks.push(task);
  logActivity(agentId, `${agentRow(agentId).name} menambah tugas "${task.title}"`);
  touch();
  return { ok: true, task };
}

function doSetTaskStatus(agentId, { id, status }) {
  const task = state.tasks.find((t) => t.id === id);
  if (!task) throw new Error(`Tugas "${id}" tidak ditemukan.`);
  if (task.agent !== agentId) {
    throw new Error(`Tugas "${id}" milik ${task.agent}, bukan ${agentId}. Agent hanya boleh mengubah tugasnya sendiri.`);
  }
  task.status = status;
  logActivity(agentId, `${agentRow(agentId).name} mengubah status "${task.title}" → ${status}`);
  touch();
  return { ok: true, task };
}

function doSendMessage(agentId, { to, text }) {
  if (to !== "team" && !AGENT_IDS.includes(to)) {
    throw new Error(`Tujuan pesan tidak dikenal: "${to}". Pakai "team" atau id agent (mas/mbak/ell).`);
  }
  const msg = { from: agentId, id: randomUUID(), text, time: new Date().toISOString(), to };
  state.messages.push(msg);
  if (state.messages.length > 500) state.messages = state.messages.slice(-500);
  const target = to === "team" ? "ruang tim" : `DM ${agentRow(to).name}`;
  logActivity(agentId, `${agentRow(agentId).name} mengirim pesan ke ${target}`);
  touch();
  return { ok: true, message: msg };
}

// ---------------------------------------------------------------- MCP
function createMcpServer(agentId) {
  const server = new McpServer({ name: "muse-team-server", version: "1.0.0" });
  const me = agentRow(agentId).name;

  server.tool(
    "get_state",
    "Lihat seluruh state tim: ketiga agent (status, aktivitas sekarang, progres checklist), semua tugas, pesan ruang tim, dan log aktivitas. Baca ini dulu sebelum update apa pun.",
    {},
    async () => ({ content: [{ text: JSON.stringify(publicState(), null, 2), type: "text" }] })
  );

  server.tool(
    "update_my_status",
    `Update status KAMU (${me}) saja: aktivitas yang sedang dikerjakan sekarang dan detail status. Otomatis menandai kamu Terhubung.`,
    { activity: z.string().min(1).describe("Aktivitas yang sedang kamu kerjakan sekarang"), detail: z.string().optional().describe("Detail status (opsional)") },
    async ({ activity, detail }) => ({ content: [{ text: JSON.stringify(doUpdateStatus(agentId, { activity, detail })), type: "text" }] })
  );

  server.tool(
    "upsert_my_task",
    `Tambah tugas baru ke checklist KAMU (${me}), atau ubah salah satu tugasmu sendiri (judul/detail/waktu/status). Isi id untuk mengubah tugas yang sudah ada; kosongkan id untuk tugas baru.`,
    {
      detail: z.string().optional(),
      id: z.string().optional().describe("ID tugas yang mau diubah (kosongkan untuk tugas baru)"),
      status: z.enum(TASK_STATUSES).optional(),
      time: z.string().optional().describe("Jam/waktu tugas, misal 19:00"),
      title: z.string().min(1).describe("Judul tugas"),
    },
    async (args) => ({ content: [{ text: JSON.stringify(doUpsertTask(agentId, args)), type: "text" }] })
  );

  server.tool(
    "set_task_status",
    `Ubah status salah satu tugas KAMU (${me}) saja. Status yang sah: done, in_progress, pending, ready, blocked, scheduled.`,
    { id: z.string().describe("ID tugas"), status: z.enum(TASK_STATUSES) },
    async ({ id, status }) => ({ content: [{ text: JSON.stringify(doSetTaskStatus(agentId, { id, status })), type: "text" }] })
  );

  server.tool(
    "send_message",
    `Kirim pesan ke ruang tim ("team") atau DM ke satu agent ("mas"/"mbak"/"ell"). Pesan ke agent lain hanya DISIMPAN untuk mereka — server tidak pernah membalas atas nama siapa pun.`,
    { text: z.string().min(1).describe("Isi pesan"), to: z.string().describe('"team" atau id agent tujuan (mas/mbak/ell)') },
    async ({ text, to }) => ({ content: [{ text: JSON.stringify(doSendMessage(agentId, { text, to })), type: "text" }] })
  );

  return server;
}

// Satu McpServer + transport per sesi MCP. Sesi terikat ke agent pemilik kunci.
const sessions = new Map(); // sessionId -> { transport, agentId }

async function handleMcp(req, res) {
  const agentId = authAgent(req);
  if (!agentId) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Kunci API tidak ada atau salah. Kirim Authorization: Bearer <kunci-agent>." }));
    return;
  }

  const sessionId = req.headers["mcp-session-id"];
  let entry = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;

  if (req.method === "GET" || req.method === "DELETE") {
    if (!entry) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Sesi MCP tidak ditemukan. Mulai dengan POST /mcp dulu." }));
      return;
    }
    if (entry.agentId !== agentId) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Sesi ini milik agent lain." }));
      return;
    }
    if (req.method === "DELETE") sessions.delete(sessionId);
    await entry.transport.handleRequest(req, res);
    return;
  }

  // POST: buat sesi baru kalau belum ada
  if (!entry) {
    const server = createMcpServer(agentId);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => sessions.set(id, { agentId, transport }),
    });
    transport.onclose = () => {
      for (const [id, e] of sessions) if (e.transport === transport) sessions.delete(id);
    };
    await server.connect(transport);
    entry = { agentId, transport };
  } else if (entry.agentId !== agentId) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Sesi ini milik agent lain." }));
    return;
  }

  let body;
  const raw = await readBody(req);
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Body bukan JSON yang sah." }));
      return;
    }
  }
  await entry.transport.handleRequest(req, res, body);
}

// ---------------------------------------------------------------- util HTTP
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

async function readJsonBody(req, res) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: "Body bukan JSON yang sah." });
    return null;
  }
}

function requireAuth(req, res) {
  const agentId = authAgent(req);
  if (!agentId) {
    sendJson(res, 401, { error: "Kunci API tidak ada atau salah. Kirim Authorization: Bearer <kunci-agent> atau header X-API-Key." });
    return null;
  }
  return agentId;
}

// ---------------------------------------------------------------- server HTTP
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (pathname === "/health") return sendJson(res, 200, { ok: true, agents: AGENT_IDS.length, storage: store.backend, updated: state.updated });

    if (pathname === "/mcp") {
      if (!["POST", "GET", "DELETE"].includes(req.method)) {
        res.writeHead(405);
        return res.end();
      }
      return await handleMcp(req, res);
    }

    if (pathname === "/api/state" && req.method === "GET") {
      return sendJson(res, 200, publicState());
    }

    if (pathname === "/api/status" && req.method === "POST") {
      const agentId = requireAuth(req, res);
      if (!agentId) return;
      const body = await readJsonBody(req, res);
      if (body === null) return;
      return sendJson(res, 200, doUpdateStatus(agentId, body));
    }

    if (pathname === "/api/tasks" && req.method === "POST") {
      const agentId = requireAuth(req, res);
      if (!agentId) return;
      const body = await readJsonBody(req, res);
      if (body === null) return;
      // Hanya {id, status} tanpa judul/detail/waktu -> ubah status saja.
      const onlyStatus = body.id && body.status && !body.title && !body.detail && !body.time;
      return sendJson(res, 200, onlyStatus ? doSetTaskStatus(agentId, body) : doUpsertTask(agentId, body));
    }

    if (pathname === "/api/messages" && req.method === "POST") {
      const agentId = requireAuth(req, res);
      if (!agentId) return;
      const body = await readJsonBody(req, res);
      if (body === null) return;
      return sendJson(res, 200, doSendMessage(agentId, body));
    }

    if ((pathname === "/" || pathname === "/index.html") && req.method === "GET") {
      const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Tidak ditemukan." }));
  } catch (err) {
    console.error("[error]", err);
    if (!res.headersSent) sendJson(res, 500, { error: String(err?.message || err) });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`muse-team-server jalan di http://localhost:${PORT}`);
  console.log(`MCP: POST http://localhost:${PORT}/mcp   Dashboard: http://localhost:${PORT}/`);
  console.log(
    store.backend === "supabase"
      ? "State: Supabase (awet — tahan restart/tidur di hosting gratis)."
      : "State: file lokal data/state.json (reset ke seed kalau server restart di hosting gratis; set SUPABASE_URL + SUPABASE_SERVICE_KEY supaya awet)."
  );
  if (USING_DEV_KEYS) {
    console.log("PERINGATAN: memakai KUNCI DEV (dev-mas-key / dev-mbak-key / dev-ell-key).");
    console.log("Set MAS_API_KEY, MBAK_API_KEY, ELL_API_KEY di env sebelum deploy publik!");
  } else {
    console.log("Kunci API dibaca dari env (MAS_API_KEY, MBAK_API_KEY, ELL_API_KEY).");
  }
});
