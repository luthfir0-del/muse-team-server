// Tes end-to-end muse-team-server (jalankan: npm test).
// Menyalakan server sendiri di port tes dengan STATE_FILE sementara (salinan
// seed), lalu memakai MCP Client resmi untuk: initialize -> tools/list ->
// tools/call. Tidak menyentuh data/state.json asli. Keluar 0 kalau semua lolos.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PORT = 3457;
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_STATE = path.join(os.tmpdir(), "muse-team-server-test-state.json");

const KEYS = { mas: "test-mas-key", mbak: "test-mbak-key", ell: "test-ell-key" };

let pass = 0;
let fail = 0;
function check(name, ok, extra = "") {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
}

async function waitHealth(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return true;
    } catch { /* belum nyala */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function getState() {
  const r = await fetch(`${BASE}/api/state`);
  return r.json();
}

function mcpClient(key) {
  return new Client({ name: "muse-team-server-test", version: "1.0.0" });
}

async function connectAs(key) {
  const client = mcpClient(key);
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  });
  await client.connect(transport);
  return { client, transport };
}

async function main() {
  // State tes = salinan seed, supaya tes tidak mengubah data asli.
  fs.copyFileSync(path.join(ROOT, "data", "seed.json"), TEST_STATE);

  const server = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      STATE_FILE: TEST_STATE,
      MAS_API_KEY: KEYS.mas,
      MBAK_API_KEY: KEYS.mbak,
      ELL_API_KEY: KEYS.ell,
    },
    stdio: "ignore",
  });

  try {
    console.log("== muse-team-server: tes end-to-end ==");
    check("server nyala (/health)", await waitHealth());
    if (!(await waitHealth(1000))) throw new Error("server tidak nyala");

    // --- 1. Seed termuat benar
    const seed = await getState();
    const masTasks = seed.tasks.filter((t) => t.agent === "mas");
    const ellTasks = seed.tasks.filter((t) => t.agent === "ell");
    check("seed: Mas 7 tugas", masTasks.length === 7, `(dapat ${masTasks.length})`);
    check("seed: Ell 15 tugas, 11 selesai",
      ellTasks.length === 15 && ellTasks.filter((t) => t.status === "done").length === 11);
    check("seed: Mbak 0 tugas, pending",
      seed.tasks.filter((t) => t.agent === "mbak").length === 0 &&
      seed.agents.find((a) => a.id === "mbak").status === "pending");

    // --- 2. MCP: initialize + tools/list sebagai Ell
    const { client: ell, transport: ellT } = await connectAs(KEYS.ell);
    const tools = await ell.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    check("tools/list: 5 tool", names.join(",") === "get_state,send_message,set_task_status,update_my_status,upsert_my_task", `(${names.join(",")})`);

    // --- 3. Ell update status sendiri via MCP -> state berubah
    await ell.callTool({ name: "update_my_status", arguments: { activity: "Tes otomatis — render uji", detail: "Status diubah oleh tes end-to-end." } });
    const afterStatus = await getState();
    check("update_my_status (Ell) mengubah state",
      afterStatus.agents.find((a) => a.id === "ell").currentActivity === "Tes otomatis — render uji");

    // --- 4. Ell ubah status tugasnya sendiri + tambah tugas baru
    await ell.callTool({ name: "set_task_status", arguments: { id: "t12", status: "done" } });
    const afterTask = await getState();
    check("set_task_status (tugas sendiri) berhasil",
      afterTask.tasks.find((t) => t.id === "t12").status === "done");
    const added = await ell.callTool({ name: "upsert_my_task", arguments: { title: "Tugas tes dari Ell", detail: "Dibuat oleh tes otomatis.", time: "23:59", status: "pending" } });
    const addedText = added.content?.[0]?.text || "";
    check("upsert_my_task (tugas baru) berhasil", addedText.includes("Tugas tes dari Ell"));

    // --- 5. Ell kirim pesan ke ruang tim
    await ell.callTool({ name: "send_message", arguments: { to: "team", text: "Halo tim, ini pesan tes dari Ell." } });
    const afterMsg = await getState();
    check("send_message ke ruang tim tersimpan",
      afterMsg.messages.some((m) => m.from === "ell" && m.to === "team" && m.text.includes("pesan tes")));

    // --- 6. Kunci salah DITOLAK (SDK melempar StreamableHTTPError, code 401)
    let wrongKeyRejected = false;
    try {
      await connectAs("kunci-salah");
    } catch (e) {
      wrongKeyRejected = e?.code === 401 || /401/.test(String(e.message || e));
    }
    check("kunci API salah ditolak (401)", wrongKeyRejected);

    // --- 7. Mas TIDAK BISA ubah tugas Ell
    // (SDK mengembalikan pelanggaran tool sebagai hasil isError, bukan throw.)
    const { client: mas } = await connectAs(KEYS.mas);
    const cross = await mas.callTool({ name: "set_task_status", arguments: { id: "t01", status: "done" } });
    const crossBlocked = cross.isError === true && /bukan mas|milik ell/i.test(cross.content?.[0]?.text || "");
    check("Mas tidak bisa ubah tugas Ell (ditolak)", crossBlocked);

    // --- 8. Mas BOLEH ubah tugasnya sendiri
    await mas.callTool({ name: "set_task_status", arguments: { id: "kampung-part4-render", status: "done" } });
    const afterMas = await getState();
    check("Mas bisa ubah tugasnya sendiri",
      afterMas.tasks.find((t) => t.id === "kampung-part4-render").status === "done");

    // --- 9. REST fallback: Mbak update status via X-API-Key
    const r = await fetch(`${BASE}/api/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": KEYS.mbak },
      body: JSON.stringify({ activity: "Tes REST — Mbak join", detail: "Join lewat REST fallback." }),
    });
    const afterRest = await getState();
    check("REST POST /api/status (Mbak) berhasil",
      r.ok && afterRest.agents.find((a) => a.id === "mbak").status === "connected" &&
      afterRest.agents.find((a) => a.id === "mbak").currentActivity === "Tes REST — Mbak join");

    // --- 10. Dashboard tersaji
    const dash = await fetch(`${BASE}/`);
    const html = await dash.text();
    check("dashboard / tersaji", dash.ok && html.includes("Ruang Kerja Bersama") && html.includes("Mas"));

    await ellT.close?.();
    console.log(`\nHasil: ${pass} lolos, ${fail} gagal.`);
    // Jangan process.exit() di sini: finally harus sempat mematikan server.
    process.exitCode = fail ? 1 : 0;
  } finally {
    server.kill();
    try { fs.unlinkSync(TEST_STATE); } catch { /* abaikan */ }
  }
}

main().catch((e) => {
  console.error("Tes crash:", e);
  process.exitCode = 1;
});
