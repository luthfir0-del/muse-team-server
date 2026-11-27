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
  return `📌 <b>${escapeHtml(agentName(ev.agent))}</b> (${fmtTime(ev.time)}): ${escapeHtml(ev.event)}`;
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
        `   ${escapeHtml(a.currentActivity || a.statusDetail || "-")}`
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
      lines.push(`   ${TASK_EMOJI[t.status] || "•"} ${escapeHtml(t.title)}${t.time && t.time !== "—" ? ` (${escapeHtml(t.time)})` : ""}`);
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
