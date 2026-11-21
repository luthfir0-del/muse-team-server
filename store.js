// store.js — penyimpanan state tim muse-team-server.
//
// Dua backend, satu antarmuka:
//   1. Supabase (kalau SUPABASE_URL + SUPABASE_SERVICE_KEY di-set) — state
//      awet walau server restart/tidur di hosting gratis (disk Render
//      gratis itu ephemeral, jadi file lokal saja tidak cukup).
//   2. File lokal data/state.json — fallback kalau Supabase tidak
//      dikonfigurasi atau tidak terjangkau. Perilaku lama, tidak berubah.
//
// Aturan yang dijamin modul ini:
// - load(): Supabase dulu kalau dikonfigurasi. Baris kosong -> pakai state
//   lokal (yang kalau belum ada dibuat dari data/seed.json), lalu simpan
//   ke Supabase. Supabase tidak terjangkau -> fallback ke file lokal +
//   peringatan di log, TIDAK crash.
// - persist(state): selalu tulis file lokal dulu (backup), lalu upsert ke
//   Supabase. Kegagalan Supabase hanya dicatat di log — state tetap
//   tersimpan di file lokal dan pemanggil tidak dilempar error.
// - State di memori server tetap sumber kebenaran selama proses jalan;
//   Supabase hanya dipakai untuk muat saat startup dan simpan saat tulis.
//
// Model Supabase: satu tabel `team_state`, satu baris (id = 1, state jsonb,
// updated_at timestamptz). SQL-nya ada di supabase.sql — EL tinggal tempel
// di SQL editor Supabase. Kunci service_role HANYA di server (env var),
// tidak pernah dikirim ke browser/dashboard.

import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

export const TEAM_STATE_TABLE = "team_state";
export const TEAM_STATE_ROW_ID = 1;

export function supabaseConfigured(env = process.env) {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY);
}

// null kalau Supabase tidak dikonfigurasi (mode file saja).
export function createSupabaseClient(env = process.env, logger = console) {
  if (!supabaseConfigured(env)) {
    if (env.SUPABASE_URL || env.SUPABASE_SERVICE_KEY) {
      logger.warn(
        "[store] Hanya satu dari SUPABASE_URL / SUPABASE_SERVICE_KEY di-set — " +
          "Supabase tidak dipakai, memakai file lokal."
      );
    }
    return null;
  }
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function loadFromFile(stateFile, seedFile) {
  if (fs.existsSync(stateFile)) {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  }
  const seed = JSON.parse(fs.readFileSync(seedFile, "utf8"));
  saveToFile(stateFile, seed);
  return seed;
}

function saveToFile(stateFile, state) {
  const tmp = stateFile + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, stateFile);
}

// Pesan error TIDAK PERNAH boleh membawa nilai kunci: kalau-kalau suatu
// pesan error menyertakan token (misalnya JWT service_role), redaksi
// pola JWT-nya. Pesan error Supabase normal ("permission denied ...",
// "Failed to fetch", dsb.) tidak mengandung kunci, jadi tidak berubah.
function sanitizeErrorMessage(message) {
  return String(message || "Supabase error").replace(
    /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    "[KUNCI DIREDAKSI]"
  );
}

export function createStateStore({ stateFile, seedFile, supabaseClient = null, logger = console } = {}) {
  const supabase = supabaseClient;
  // Error Supabase TERAKHIR (pesan saja, tanpa nilai kunci), supaya /health
  // bisa menampilkannya sebagai `supabaseError` untuk diagnosis tanpa
  // membuka log. null kalau tidak ada error (atau Supabase tidak dipakai).
  // Dibersihkan (null) setiap operasi Supabase berhasil.
  let lastError = null;

  async function loadFromSupabase() {
    const { data, error } = await supabase
      .from(TEAM_STATE_TABLE)
      .select("state")
      .eq("id", TEAM_STATE_ROW_ID)
      .maybeSingle();
    if (error) throw new Error(`Supabase baca gagal: ${error.message}`);
    return data?.state ?? null;
  }

  async function saveToSupabase(state) {
    const { error } = await supabase
      .from(TEAM_STATE_TABLE)
      .upsert({ id: TEAM_STATE_ROW_ID, state, updated_at: new Date().toISOString() });
    if (error) throw new Error(`Supabase tulis gagal: ${error.message}`);
  }

  // Muat state saat startup. Tidak pernah melempar karena Supabase —
  // kegagalan Supabase selalu jatuh ke file lokal.
  async function load() {
    if (supabase) {
      try {
        const remote = await loadFromSupabase();
        if (remote) {
          // Supabase punya state: sinkronkan juga ke file lokal (backup).
          saveToFile(stateFile, remote);
          lastError = null;
          return remote;
        }
        // Baris Supabase kosong: pakai state lokal (dibuat dari seed kalau
        // belum ada), lalu simpan ke Supabase supaya lain kali terisi.
        const local = loadFromFile(stateFile, seedFile);
        await saveToSupabase(local);
        lastError = null;
        return local;
      } catch (err) {
        lastError = sanitizeErrorMessage(err.message);
        logger.warn(`[store] Supabase tidak terjangkau, memakai file lokal: ${err.message}`);
      }
    }
    return loadFromFile(stateFile, seedFile);
  }

  // Simpan state. Tulis file lokal dulu (sinkron — error disk tetap
  // dilempar seperti perilaku lama), lalu upsert ke Supabase di latar
  // belakang. Mengembalikan promise boolean: true kalau Supabase berhasil,
  // false kalau Supabase tidak dipakai / gagal (sudah dicatat di log).
  function persist(state) {
    saveToFile(stateFile, state);
    if (!supabase) return Promise.resolve(false);
    return saveToSupabase(state)
      .then(() => {
        lastError = null;
        return true;
      })
      .catch((err) => {
        lastError = sanitizeErrorMessage(err.message);
        logger.warn(
          `[store] Gagal simpan ke Supabase (state tetap tersimpan di file lokal): ${err.message}`
        );
        return false;
      });
  }

  return {
    load,
    persist,
    get backend() {
      return supabase ? "supabase" : "file";
    },
    get supabaseEnabled() {
      return Boolean(supabase);
    },
    // Pesan error Supabase terakhir (string) atau null. Hanya pesan —
    // tidak pernah berisi nilai kunci (diredaksi di sanitizeErrorMessage).
    get lastError() {
      return lastError;
    },
  };
}
