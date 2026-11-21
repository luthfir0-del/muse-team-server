// Tes lapisan penyimpanan Supabase muse-team-server (jalankan: npm test).
// Memakai Supabase PALSU (bukan project sungguhan, tanpa kredensial asli):
//   (a) tanpa Supabase -> fallback file persis seperti sebelumnya;
//   (b) Supabase palsu terkonfigurasi -> state dimuat dari sana, tulis
//       masuk ke sana, seed-on-empty jalan;
//   (c) Supabase palsu gagal -> jatuh ke file lokal tanpa crash.
// Plus satu tes integrasi: server dinyalakan dengan SUPABASE_URL yang
// tidak terjangkau — server harus tetap nyala dan melayani dari file.
// Tidak menyentuh data/state.json asli. Keluar 0 kalau semua lolos.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStateStore, createSupabaseClient, supabaseConfigured } from "../store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SEED_FILE = path.join(ROOT, "data", "seed.json");
const PORT = 3458;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
function check(name, ok, extra = "") {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
}

// ---------------------------------------------------------------- fake Supabase
// Meniru rantai postgrest-js yang dipakai store.js:
//   client.from(t).select("state").eq("id", 1).maybeSingle()
//   client.from(t).upsert({ id, state, updated_at })
class FakeTable {
  constructor(fake) { this.fake = fake; this._eq = null; }
  select() { return this; }
  eq(col, val) { this._eq = [col, val]; return this; }
  async maybeSingle() {
    this.fake.calls.push({ op: "select", eq: this._eq });
    if (this.fake.failSelect) throw new Error("Supabase palsu: select gagal (jaringan putus)");
    const row = this.fake.rows.get(this._eq?.[1]);
    return { data: row ?? null, error: null };
  }
  async upsert(row) {
    this.fake.calls.push({ op: "upsert", id: row.id, tasks: row.state?.tasks?.length });
    if (this.fake.failUpsert) return { data: null, error: { message: "Supabase palsu: upsert gagal" } };
    this.fake.rows.set(row.id, { id: row.id, state: row.state, updated_at: row.updated_at });
    return { data: [row], error: null };
  }
}

class FakeSupabase {
  constructor() { this.rows = new Map(); this.calls = []; this.failSelect = false; this.failUpsert = false; }
  from() { return new FakeTable(this); }
}

// ---------------------------------------------------------------- util tes
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mts-supabase-"));
}
function collectingLogger(warnings) {
  return { warn: (m) => warnings.push(String(m)), log: () => {} };
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function seedState() {
  return readJson(SEED_FILE);
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

async function main() {
  console.log("== muse-team-server: tes penyimpanan Supabase ==");
  const dirs = [];
  try {
    // --- 0. Deteksi konfigurasi env
    check("supabaseConfigured: kosong -> false", supabaseConfigured({}) === false);
    check("supabaseConfigured: lengkap -> true",
      supabaseConfigured({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_KEY: "kunci" }) === true);
    const warnOnlyOne = [];
    const clientOne = createSupabaseClient(
      { SUPABASE_URL: "https://x.supabase.co" },
      collectingLogger(warnOnlyOne)
    );
    check("hanya satu env di-set -> client null + peringatan",
      clientOne === null && warnOnlyOne.some((w) => /hanya satu/i.test(w)));
    check("tanpa env -> client null", createSupabaseClient({}) === null);

    // --- (a) Tanpa Supabase: fallback file persis seperti sebelumnya
    {
      const dir = tmpDir(); dirs.push(dir);
      const warnings = [];
      const store = createStateStore({
        stateFile: path.join(dir, "state.json"),
        seedFile: SEED_FILE,
        supabaseClient: null,
        logger: collectingLogger(warnings),
      });
      check("file-only: backend = file", store.backend === "file" && store.supabaseEnabled === false);
      const loaded = await store.load();
      check("file-only: load seed dari seed.json (Mas 7 tugas)",
        loaded.tasks.filter((t) => t.agent === "mas").length === 7);
      check("file-only: state.json dibuat di disk",
        fs.existsSync(path.join(dir, "state.json")));
      loaded.agents.find((a) => a.id === "ell").currentActivity = "Tes file-only";
      const wrote = await store.persist(loaded);
      check("file-only: persist tulis file (tanpa Supabase)",
        wrote === false &&
        readJson(path.join(dir, "state.json")).agents.find((a) => a.id === "ell").currentActivity === "Tes file-only");
      check("file-only: tanpa peringatan", warnings.length === 0, `(${warnings.join("; ")})`);
    }

    // --- (b1) Supabase ada baris: load dari Supabase, bukan dari file
    {
      const dir = tmpDir(); dirs.push(dir);
      const warnings = [];
      const fake = new FakeSupabase();
      const remote = seedState();
      remote.agents.find((a) => a.id === "mas").currentActivity = "Dari Supabase — render jalan";
      fake.rows.set(1, { id: 1, state: remote, updated_at: "2026-11-21T10:00:00.000Z" });
      // File lokal sengaja beda isinya — yang menang harus Supabase.
      const local = seedState();
      local.agents.find((a) => a.id === "mas").currentActivity = "Dari file lokal";
      fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(local, null, 2));
      const store = createStateStore({
        stateFile: path.join(dir, "state.json"),
        seedFile: SEED_FILE,
        supabaseClient: fake,
        logger: collectingLogger(warnings),
      });
      check("supabase: backend = supabase", store.backend === "supabase" && store.supabaseEnabled === true);
      const loaded = await store.load();
      check("supabase: load menang dari Supabase (bukan file)",
        loaded.agents.find((a) => a.id === "mas").currentActivity === "Dari Supabase — render jalan");
      check("supabase: file lokal ikut disinkronkan dari Supabase",
        readJson(path.join(dir, "state.json")).agents.find((a) => a.id === "mas").currentActivity === "Dari Supabase — render jalan");
      check("supabase: load memanggil select", fake.calls.some((c) => c.op === "select"));
    }

    // --- (b2) Supabase baris kosong: seed dari seed.json + upsert tercatat
    {
      const dir = tmpDir(); dirs.push(dir);
      const fake = new FakeSupabase(); // tanpa baris
      const store = createStateStore({
        stateFile: path.join(dir, "state.json"),
        seedFile: SEED_FILE,
        supabaseClient: fake,
        logger: collectingLogger([]),
      });
      const loaded = await store.load();
      const upsert = fake.calls.find((c) => c.op === "upsert");
      check("supabase kosong: load mengembalikan seed (Mas 7 tugas)",
        loaded.tasks.filter((t) => t.agent === "mas").length === 7);
      check("supabase kosong: seed di-upsert ke Supabase",
        Boolean(upsert) && upsert.id === 1 && upsert.tasks === 22, `(upsert: ${JSON.stringify(upsert)})`);
      check("supabase kosong: file lokal dibuat", fs.existsSync(path.join(dir, "state.json")));
    }

    // --- (b3) Supabase: persist tulis ke Supabase DAN file
    {
      const dir = tmpDir(); dirs.push(dir);
      const fake = new FakeSupabase();
      fake.rows.set(1, { id: 1, state: seedState(), updated_at: "2026-11-21T10:00:00.000Z" });
      const store = createStateStore({
        stateFile: path.join(dir, "state.json"),
        seedFile: SEED_FILE,
        supabaseClient: fake,
        logger: collectingLogger([]),
      });
      const loaded = await store.load();
      loaded.agents.find((a) => a.id === "mbak").currentActivity = "Mbak join lewat tes";
      loaded.agents.find((a) => a.id === "mbak").status = "connected";
      const wrote = await store.persist(loaded);
      check("supabase: persist mengembalikan true", wrote === true);
      check("supabase: upsert tercatat dengan state baru",
        fake.rows.get(1).state.agents.find((a) => a.id === "mbak").currentActivity === "Mbak join lewat tes");
      check("supabase: file lokal ikut diperbarui",
        readJson(path.join(dir, "state.json")).agents.find((a) => a.id === "mbak").currentActivity === "Mbak join lewat tes");
    }

    // --- (c1) Supabase select gagal: fallback ke file, tidak crash
    {
      const dir = tmpDir(); dirs.push(dir);
      const warnings = [];
      const fake = new FakeSupabase();
      fake.failSelect = true;
      const local = seedState();
      local.agents.find((a) => a.id === "ell").currentActivity = "Tetap dari file";
      fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(local, null, 2));
      const store = createStateStore({
        stateFile: path.join(dir, "state.json"),
        seedFile: SEED_FILE,
        supabaseClient: fake,
        logger: collectingLogger(warnings),
      });
      let loaded;
      let threw = false;
      try { loaded = await store.load(); } catch { threw = true; }
      check("supabase gagal baca: load tidak melempar", threw === false);
      check("supabase gagal baca: fallback ke file lokal",
        loaded?.agents.find((a) => a.id === "ell").currentActivity === "Tetap dari file");
      check("supabase gagal baca: peringatan dicatat",
        warnings.some((w) => /tidak terjangkau/i.test(w)), `(${warnings.join("; ")})`);
      check("supabase gagal baca: lastError berisi pesan error saja",
        typeof store.lastError === "string" && store.lastError.includes("select gagal"), `(lastError: ${store.lastError})`);
    }

    // --- (c1b) lastError: pesan error yang mengandung token diredaksi
    {
      const dir = tmpDir(); dirs.push(dir);
      const warnings = [];
      const evilFake = {
        from() {
          return {
            select() { return this; },
            eq() { return this; },
            async maybeSingle() {
              throw new Error("permission denied, key eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSJ9.abc123def456");
            },
            async upsert() { return { data: null, error: null }; },
          };
        },
      };
      const store = createStateStore({
        stateFile: path.join(dir, "state.json"),
        seedFile: SEED_FILE,
        supabaseClient: evilFake,
        logger: collectingLogger(warnings),
      });
      let loaded;
      let threw = false;
      try { loaded = await store.load(); } catch { threw = true; }
      check("lastError: load tetap fallback ke file walau pesan mengandung token",
        threw === false && loaded?.tasks.filter((t) => t.agent === "mas").length === 7);
      check("lastError: JWT dalam pesan error diredaksi, tidak bocor",
        typeof store.lastError === "string" &&
        !store.lastError.includes("eyJ") &&
        store.lastError.includes("[KUNCI DIREDAKSI]"), `(lastError: ${store.lastError})`);
    }

    // --- (c1c) lastError: ter-set saat gagal, dibersihkan saat berhasil
    {
      const dir = tmpDir(); dirs.push(dir);
      const fake = new FakeSupabase();
      fake.rows.set(1, { id: 1, state: seedState(), updated_at: "2026-11-21T10:00:00.000Z" });
      const store = createStateStore({
        stateFile: path.join(dir, "state.json"),
        seedFile: SEED_FILE,
        supabaseClient: fake,
        logger: collectingLogger([]),
      });
      const loaded = await store.load();
      check("lastError: null setelah load Supabase berhasil", store.lastError === null);
      fake.failUpsert = true;
      loaded.agents[0].currentActivity = "Tes lastError";
      const wroteFail = await store.persist(loaded);
      check("lastError: ter-set setelah persist gagal",
        wroteFail === false && typeof store.lastError === "string" && store.lastError.includes("upsert gagal"),
        `(lastError: ${store.lastError})`);
      fake.failUpsert = false;
      const wroteOk = await store.persist(loaded);
      check("lastError: dibersihkan setelah persist berhasil", wroteOk === true && store.lastError === null);
    }

    // --- (c2) Supabase upsert gagal: persist tetap tulis file, tidak throw
    {
      const dir = tmpDir(); dirs.push(dir);
      const warnings = [];
      const fake = new FakeSupabase();
      fake.rows.set(1, { id: 1, state: seedState(), updated_at: "2026-11-21T10:00:00.000Z" });
      fake.failUpsert = true;
      const store = createStateStore({
        stateFile: path.join(dir, "state.json"),
        seedFile: SEED_FILE,
        supabaseClient: fake,
        logger: collectingLogger(warnings),
      });
      const loaded = await store.load();
      loaded.agents.find((a) => a.id === "mas").currentActivity = "Update saat Supabase mati";
      let wrote;
      let threw = false;
      try { wrote = await store.persist(loaded); } catch { threw = true; }
      check("supabase gagal tulis: persist tidak melempar", threw === false);
      check("supabase gagal tulis: persist mengembalikan false", wrote === false);
      check("supabase gagal tulis: lastError ter-set",
        typeof store.lastError === "string" && store.lastError.includes("upsert gagal"), `(lastError: ${store.lastError})`);
      check("supabase gagal tulis: file lokal tetap diperbarui",
        readJson(path.join(dir, "state.json")).agents.find((a) => a.id === "mas").currentActivity === "Update saat Supabase mati");
      check("supabase gagal tulis: peringatan dicatat",
        warnings.some((w) => /Gagal simpan ke Supabase/i.test(w)));
    }

    // --- (c3) Integrasi: server nyala dengan Supabase yang tidak terjangkau
    {
      const dir = tmpDir(); dirs.push(dir);
      const testState = path.join(dir, "state.json");
      fs.copyFileSync(SEED_FILE, testState);
      const server = spawn(process.execPath, ["server.js"], {
        cwd: ROOT,
        env: {
          ...process.env,
          PORT: String(PORT),
          STATE_FILE: testState,
          MAS_API_KEY: "test-mas-key",
          MBAK_API_KEY: "test-mbak-key",
          ELL_API_KEY: "test-ell-key",
          SUPABASE_URL: "http://127.0.0.1:9",
          SUPABASE_SERVICE_KEY: "test-dummy-service-key",
        },
        stdio: "ignore",
      });
      try {
        check("integrasi: server nyala walau Supabase tidak terjangkau", await waitHealth());
        if (!(await waitHealth(1000))) throw new Error("server tidak nyala");
        const health = await (await fetch(`${BASE}/health`)).json();
        check("integrasi: /health melaporkan storage supabase (terkonfigurasi)",
          health.storage === "supabase", `(dapat ${health.storage})`);
        check("integrasi: /health menampilkan supabaseError saat Supabase tidak terjangkau",
          typeof health.supabaseError === "string" && health.supabaseError.length > 0,
          `(supabaseError: ${health.supabaseError})`);
        const before = await (await fetch(`${BASE}/api/state`)).json();
        check("integrasi: state dari file (Mas 7 tugas)",
          before.tasks.filter((t) => t.agent === "mas").length === 7);
        const r = await fetch(`${BASE}/api/status`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-Key": "test-mbak-key" },
          body: JSON.stringify({ activity: "Tes integrasi — Mbak join saat Supabase mati" }),
        });
        const after = await (await fetch(`${BASE}/api/state`)).json();
        check("integrasi: tulis REST tetap berhasil saat Supabase mati",
          r.ok && after.agents.find((a) => a.id === "mbak").currentActivity === "Tes integrasi — Mbak join saat Supabase mati");
        check("integrasi: tulis tersimpan di file lokal",
          readJson(testState).agents.find((a) => a.id === "mbak").currentActivity === "Tes integrasi — Mbak join saat Supabase mati");
      } finally {
        server.kill();
      }
    }

    console.log(`\nHasil: ${pass} lolos, ${fail} gagal.`);
    process.exitCode = fail ? 1 : 0;
  } finally {
    for (const dir of dirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* abaikan */ }
    }
  }
}

main().catch((e) => {
  console.error("Tes crash:", e);
  process.exitCode = 1;
});
