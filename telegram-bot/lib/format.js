// lib/format.js — format snapshot/peristiwa server tim jadi teks Telegram
// (Bahasa Indonesia, jam WIB). Semua teks dari server di-escape sebelum
// masuk parse_mode HTML.

import { AGENT_NAMES } from "./config.js";
import { escapeHtml } from "./telegram.js";

const WIB = new Intl.DateTimeFormat("id-ID", {
  timeZone: "Asia/Jakarta",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

export function fmtTime(isoOrMs) {
  const d = new Date(isoOrMs);
  if (Number.isNaN(d.getTime())) return "-";
  return WIB.format(d).replace(".", ":");
}

export function agentName(id) {
  return AGENT_NAMES[id] || id || "-";
}

const TASK_EMOJI = {
  done: "✅",
  in_progress: "🔄",
  pending: "⏳",
  ready: "🟢",
  blocked: "🚫",
  scheduled: "📅",
};

export function formatEvent(ev) {
  if (ev.kind === "message") {
    const dest = ev.to === "team" ? "ruang tim" : `DM ${agentName(ev.to)}`;
    return `💬 <b>${escapeHtml(agentName(ev.from))}</b> → ${escapeHtml(dest)} (${fmtTime(ev.time)}):\n${escapeHtml(ev.text)}`;
  }
  return `<b>${escapeHtml(agentName(ev.agent))}</b>\n${formatEventBody(ev)}`;
}

// Format ringkas EL (28 Nov 2026): notifikasi aktivitas TIDAK BOLEH lagi
// membuang seluruh teks status (punya Mas bisa 6000+ karakter, isinya
// pengulangan). Yang dikirim hanya:
//   nama agen
//   nama tugas (+ info terbaru, maks ~200 karakter) - link1 - link2
// Link diambil dari teks itu sendiri (URL penuh atau domain telanjang
// seperti facebook.com/reel/..., youtube.com/shorts/...).

const LINK_DOMAINS = [
  "facebook.com",
  "instagram.com",
  "youtube.com",
  "youtu.be",
  "tiktok.com",
  "twitter.com",
  "x.com",
];

const MAX_ACTIVITY_CHARS = 200;
const MAX_LINKS = 3;

export function extractLinks(text = "") {
  const found = [];
  const push = (u) => {
    const clean = String(u).replace(/[.,);:'"\]}>]+$/g, "");
    if (!clean || found.includes(clean) || found.length >= MAX_LINKS) return;
    found.push(clean);
  };
  for (const m of String(text).matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) push(m[0]);
  const bare = new RegExp(
    `(?:^|[\\s(])((?:${LINK_DOMAINS.map((d) => d.replace(".", "\\.")).join("|")})/[^\\s<>"')\\]]+)`,
    "gi"
  );
  for (const m of String(text).matchAll(bare)) push(`https://${m[1]}`);
  return found;
}

// Padatkan teks aktivitas: buang prefix "Nama update status: " /
// "Nama mengubah tugas ", buang tanda kutip pembungkus judul tugas,
// lalu potong ke ~200 karakter di batas kata (info terbaru selalu di
// awal teks, sisanya pengulangan riwayat).
export function compactActivityText(text = "") {
  let t = String(text).trim();
  t = t.replace(/^\S+\s+update status:\s*/i, "");
  t = t.replace(/^\S+\s+mengubah tugas\s*/i, "");
  t = t.replace(/^["“”]/, "").replace(/["”]$/, "");
  if (t.length > MAX_ACTIVITY_CHARS) {
    let cut = t.slice(0, MAX_ACTIVITY_CHARS);
    const sp = cut.lastIndexOf(" ");
    if (sp > 120) cut = cut.slice(0, sp);
    t = `${cut}…`;
  }
  return t;
}

// Isi peristiwa aktivitas TANPA header nama agent — dipakai saat beberapa
// peristiwa dari agent yang sama digabung dalam satu digest (header nama
// agent cukup sekali, lihat groupEventParts).
export function formatEventBody(ev) {
  if (ev.kind === "message") {
    const dest = ev.to === "team" ? "ruang tim" : `DM ${agentName(ev.to)}`;
    return `→ ${escapeHtml(dest)} (${fmtTime(ev.time)}):\n${escapeHtml(ev.text)}`;
  }
  const raw = ev.event || "";
  const prose = compactActivityText(raw);
  const links = extractLinks(raw);
  const linkPart = links.length ? ` - ${links.map((l) => escapeHtml(l)).join(" - ")}` : "";
  return `${escapeHtml(prose)}${linkPart}`;
}

// Gabungkan peristiwa jadi bagian-bagian digest: aktivitas berurutan dari
// agent yang sama berbagi satu header nama agent (format EL: nama agent,
// lalu satu baris per tugas + link). Pesan chat tetap berdiri sendiri.
export function groupEventParts(events, team) {
  const label = team ? `[${team.name || team.id}] ` : "";
  const parts = [];
  let currentAgent = null;
  let lines = [];
  const flush = () => {
    if (lines.length) {
      parts.push(`${label}<b>${escapeHtml(agentName(currentAgent))}</b>\n${lines.join("\n")}`);
      lines = [];
      currentAgent = null;
    }
  };
  for (const ev of events) {
    if (ev.kind === "activity") {
      if (ev.agent !== currentAgent) {
        flush();
        currentAgent = ev.agent;
      }
      lines.push(formatEventBody(ev));
    } else {
      flush();
      parts.push(formatEventForTeam(ev, team));
    }
  }
  flush();
  return parts;
}

// Ringkasan status SATU tim untuk /status: tiap agent + aktivitas + progres tugas.
export function formatStatus(state, team) {
  const lines = [`<b>Status tim — ${escapeHtml(team?.name || team?.id || "tim")}</b>`];
  for (const a of state.agents || []) {
    const done = a.tasksDone ?? 0;
    const total = a.tasksTotal ?? 0;
    const conn = a.status === "connected" ? "🟢" : "🔴";
    lines.push(
      `\n${conn} <b>${escapeHtml(a.name)}</b> — ${done}/${total} tugas\n` +
        `   ${escapeHtml(compactActivityText(a.currentActivity || a.statusDetail || "-"))}`
    );
  }
  const blocked = (state.tasks || []).filter((t) => t.status === "blocked");
  if (blocked.length) {
    lines.push("\n🚫 <b>Tugas macet:</b>");
    for (const t of blocked) lines.push(`   • ${escapeHtml(t.title)} (${agentName(t.agent)})`);
  }
  lines.push(`\n<i>Update terakhir server: ${fmtTime(state.updated)} WIB</i>`);
  return lines.join("\n");
}

// Daftar tugas SATU tim untuk /tugas.
export function formatTasks(state, team) {
  const lines = [`<b>Daftar tugas — ${escapeHtml(team?.name || team?.id || "tim")}</b>`];
  for (const a of state.agents || []) {
    const tasks = (state.tasks || []).filter((t) => t.agent === a.id);
    lines.push(`\n<b>${escapeHtml(a.name)}</b> (${tasks.filter((t) => t.status === "done").length}/${tasks.length} selesai)`);
    if (!tasks.length) {
      lines.push("   — belum ada tugas");
      continue;
    }
    for (const t of tasks) {
      const links = extractLinks(`${t.title || ""} ${t.detail || ""}`);
      const linkPart = links.length ? ` - ${links.map((l) => escapeHtml(l)).join(" - ")}` : "";
      lines.push(`   ${TASK_EMOJI[t.status] || "•"} ${escapeHtml(t.title)}${t.time && t.time !== "—" ? ` (${escapeHtml(t.time)})` : ""}${linkPart}`);
    }
  }
  return lines.join("\n");
}

// Daftar tim yang terlihat dari satu chat (untuk /tim).
// `activeId` = tim aktif saat ini di chat itu (ditandai ▶).
export function formatTeamList(teams, activeId) {
  if (!teams.length) return "Belum ada tim yang terdaftar untuk chat ini.";
  const lines = ["<b>Tim yang bisa kamu akses:</b>"];
  for (const t of teams) {
    const mark = t.id === activeId ? "▶ " : "   ";
    const status = t.status === "active" ? "" : ` (${t.status})`;
    lines.push(`${mark}<code>${escapeHtml(t.id)}</code> — ${escapeHtml(t.name)}${status}`);
  }
  lines.push(`\nPindah tim: <code>/tim &lt;id&gt;</code>`);
  return lines.join("\n");
}

// Satu peristiwa poll untuk SATU tim — diberi label tim supaya EL yang
// memantau banyak tim tidak bingung peristiwa ini dari tim mana.
export function formatEventForTeam(ev, team) {
  const label = team ? `[${team.name || team.id}] ` : "";
  return label + formatEvent(ev);
}

export const HELP_TEXT =
  `<b>Bot Tim — multi-tim</b>\n` +
  `Pelengkap kantor virtual 3D, jalur gampang dari HP. Satu bot untuk\n` +
  `semua tim; tiap tim terpisah (server, kunci, dan chat sendiri).\n\n` +
  `<b>Perintah tim:</b>\n` +
  `/tim — daftar tim yang bisa kamu akses\n` +
  `/tim &lt;id&gt; — pindah tim aktif di chat ini\n` +
  `/status [tim] — status + aktivitas tim aktif (atau tim lain)\n` +
  `/tugas [tim] — daftar tugas tim aktif (atau tim lain)\n\n` +
  `<b>Perintah pesan (ke tim aktif):</b>\n` +
  `/pesan &lt;teks&gt; — kirim pesan ke ruang tim\n` +
  `/dm &lt;agent&gt; &lt;teks&gt; — kirim DM ke satu agent tim itu\n` +
  `/help — pesan ini\n\n` +
  `<b>Gabung tim baru:</b>\n` +
  `/gabung &lt;id&gt; &lt;url-server&gt; &lt;kunci-agent&gt; [nama] — daftarkan timmu\n` +
  `/notify &lt;id&gt; — jadikan chat/grup ini tujuan notifikasi tim itu\n` +
  `(EL) /setuju &lt;id&gt; / /tolak &lt;id&gt; — setujui/tolak tim pending\n` +
  `(EL/pemilik) /hapus &lt;id&gt; — hapus tim dari bot\n\n` +
  `Ketik pesan biasa (bukan perintah) juga langsung terkirim ke ruang tim aktif.\n` +
  `Pesan EL di ruang tim ditandai <b>[EL]</b> supaya tim tahu itu dari pemilik.`;
