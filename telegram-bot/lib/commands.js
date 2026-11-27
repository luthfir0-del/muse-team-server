// lib/commands.js — logika perintah masuk dari Telegram (v2, MULTI-TIM).
// Dipakai webhook (api/webhook.js) dan runner lokal (scripts/local-bot.mjs).
// fetchState/sendTeamMessage/verifyTeamConnection di-inject supaya gampang
// dites tanpa jaringan; registry di-inject supaya tes bisa memakai registry
// palsu (lihat test/teams.test.mjs).
//
// Model akses (lihat lib/registry.js):
//   - EL (OWNER_CHAT_ID) = super-owner: melihat + memerintah SEMUA tim.
//   - Pemilik tim lain: hanya timnya sendiri.
//   - Chat grup yang terikat sebagai notifyChatId sebuah tim: tim itu saja.
//   - Chat yang tidak terikat tim mana pun: ditolak, KECUALI /start
//     (penjelasan + cara gabung) dan /gabung (pendaftaran tim baru).
//
// Tim aktif per chat: chat dengan 1 tim terlihat selalu memakai tim itu;
// chat dengan banyak tim (EL) memakai pilihan /tim (disimpan di memori
// proses — cold start mengembalikan ke tim default, lihat registry.js).
//
// KUNCI TIDAK PERNAH di-echo: perintah /gabung menerima kunci agent di
// teks pesan, tapi tidak ada balasan/log yang pernah memuat nilainya.
// Setelah /gabung berhasil, bot berusaha menghapus pesan /gabung itu
// (best-effort) — pemilik juga disarankan menghapusnya manual.

import { AGENT_IDS, EL_PREFIX } from "./config.js";
import { HELP_TEXT, agentName, formatStatus, formatTasks, formatTeamList } from "./format.js";
import { fetchState as realFetchState, sendTeamMessage as realSendTeamMessage, verifyTeamConnection as realVerifyTeamConnection } from "./teamApi.js";

const NOT_OWNER = "Bot ini hanya untuk tim yang terdaftar. Kalau timmu belum gabung, kirim /gabung untuk mendaftarkannya. 🙂";
const BOOTSTRAP = (chatId) =>
  `Halo! Bot Tim belum kenal pemiliknya.\n\nChat id kamu: <code>${chatId}</code>\n\nTempel angka itu sebagai <code>OWNER_CHAT_ID</code> di Environment Variables bot, redeploy, lalu kirim /start lagi.`;

// Kembalikan { reply, notify? } — reply = teks balasan ke chat pengirim
// (format HTML); notify = pesan tambahan ke chat lain (mis. EL saat ada
// tim baru gabung) — dikirim pemanggil (webhook/runner lokal).
export async function handleTelegramMessage(msg, deps = {}) {
  const registry = deps.registry;
  const fetchState = deps.fetchState || realFetchState;
  const sendTeamMessage = deps.sendTeamMessage || realSendTeamMessage;
  const verifyTeamConnection = deps.verifyTeamConnection || realVerifyTeamConnection;
  const deleteMessage = deps.deleteMessage || null;
  const ownerChatId = deps.ownerChatId ?? process.env.OWNER_CHAT_ID ?? "";

  const chatId = msg?.chat?.id;
  const chatType = msg?.chat?.type || "private";
  const fromId = msg?.from?.id;
  // Pengirim pesan (di grup: id user; di chat pribadi: sama dengan chat id).
  // Dipakai untuk otorisasi perintah admin — chat grup belum tentu terikat
  // tim, tapi pemilik tim tetap bisa memerintah dari grup lewat id-nya.
  const senderId = String(fromId || chatId);
  const text = typeof msg?.text === "string" ? msg.text.trim() : "";
  const [cmd, ...rest] = text ? text.split(/\s+/) : [""];
  const isGroup = chatType === "group" || chatType === "supergroup";

  if (!registry) return { reply: "Bot belum dikonfigurasi (registry tim kosong)." };

  // Bootstrap: super-owner belum dikonfigurasi.
  if (!ownerChatId) {
    if (text === "/start") return { reply: BOOTSTRAP(chatId) };
    return { reply: "Bot belum dikonfigurasi (OWNER_CHAT_ID kosong). Kirim /start untuk melihat chat id kamu." };
  }

  if (!text) {
    return { reply: "Bot ini hanya meneruskan pesan teks. Ketik /help untuk daftar perintah." };
  }

  // /gabung boleh dari chat mana pun — justru itu cara tim baru masuk.
  if (cmd === "/gabung" || cmd === "/daftar") {
    return handleJoin({ rest, chatId, chatType, fromId, messageId: msg.message_id, registry, verifyTeamConnection, deleteMessage, ownerChatId });
  }

  const teams = await registry.listTeams();
  const visible = registry.teamsVisibleTo(teams, chatId);

  if (cmd === "/start") {
    if (!visible.length) {
      return {
        reply:
          `Halo! Aku Bot Tim — satu bot untuk banyak tim.\n\n` +
          `Chat ini belum terikat tim mana pun. Daftarkan timmu:\n` +
          `<code>/gabung &lt;id-tim&gt; &lt;url-server&gt; &lt;kunci-agent&gt; [nama-tim]</code>\n\n` +
          `Contoh: <code>/gabung kampung https://tim-kampung.vercel.app KUNCI-AGENT "Tim Kampung"</code>\n\n` +
          `Bot akan memverifikasi server itu dulu (cek /api/state + /health + satu pesan jabat tangan ke ruang tim), lalu timmu aktif.`,
      };
    }
    const { team: active } = registry.resolveTeam(teams, chatId);
    return {
      reply:
        `Halo, EL! 👋 Bot Tim sudah kenal kamu.\n\n` +
        `${formatTeamList(visible, active?.id)}\n\n` +
        HELP_TEXT,
    };
  }

  // Perintah admin tim — dicek SEBELUM gerbang "chat terlihat", supaya
  // pemilik tim tetap bisa memerintah dari grup yang belum terikat
  // (otorisasi memakai id pengirim, bukan id chat).
  // /notify <id-tim> — jadikan chat/grup ini tujuan notifikasi tim itu.
  if (cmd === "/notify") {
    const targetId = (rest[0] || "").toLowerCase();
    if (!targetId) return { reply: "Pakai: /notify <id-tim> — chat ini jadi tujuan notifikasi tim itu." };
    const team = await registry.getTeam(targetId);
    if (!team) return { reply: `Tim "${targetId}" tidak ditemukan.` };
    const isOwner = registry.isSuperOwner(senderId) || team.ownerChatId === senderId;
    if (!isOwner) return { reply: "Hanya pemilik tim (atau EL) yang boleh mengatur notifikasi tim ini." };
    try {
      await registry.setNotifyChat(targetId, String(chatId));
      return { reply: `✅ Notifikasi tim <b>${team.name}</b> sekarang dikirim ke chat ini.` };
    } catch (e) {
      return { reply: `❌ Gagal mengatur notifikasi: ${e.message}` };
    }
  }

  // /setuju / /tolak — super-owner (EL) menyetujui/menolak tim pending.
  if (cmd === "/setuju" || cmd === "/tolak") {
    if (!registry.isSuperOwner(senderId)) return { reply: "Hanya EL yang boleh menyetujui/menolak tim." };
    const targetId = (rest[0] || "").toLowerCase();
    if (!targetId) return { reply: `Pakai: ${cmd} <id-tim>` };
    const team = await registry.getTeam(targetId);
    if (!team) return { reply: `Tim "${targetId}" tidak ditemukan.` };
    const status = cmd === "/setuju" ? "active" : "disabled";
    try {
      await registry.setTeamStatus(targetId, status);
      const note =
        status === "active"
          ? `✅ Tim <b>${team.name}</b> (<code>${team.id}</code>) sudah disetujui dan aktif.`
          : `Tim <b>${team.name}</b> (<code>${team.id}</code>) ditolak/dinonaktifkan.`;
      const notify =
        team.ownerChatId !== senderId
          ? [{ chatId: team.ownerChatId, text: note }]
          : undefined;
      return { reply: note, notify };
    } catch (e) {
      return { reply: `❌ Gagal: ${e.message}` };
    }
  }

  // /hapus — super-owner atau pemilik tim menghapus tim dinamis dari bot.
  if (cmd === "/hapus") {
    const targetId = (rest[0] || "").toLowerCase();
    if (!targetId) return { reply: "Pakai: /hapus <id-tim>" };
    const team = await registry.getTeam(targetId);
    if (!team) return { reply: `Tim "${targetId}" tidak ditemukan.` };
    const allowed = registry.isSuperOwner(senderId) || team.ownerChatId === senderId;
    if (!allowed) return { reply: "Hanya pemilik tim (atau EL) yang boleh menghapus tim ini." };
    try {
      await registry.removeTeam(targetId);
      const note = `Tim <b>${team.name}</b> (<code>${team.id}</code>) sudah dihapus dari bot.`;
      const notify =
        team.ownerChatId !== senderId
          ? [{ chatId: team.ownerChatId, text: note }]
          : undefined;
      return { reply: note, notify };
    } catch (e) {
      return { reply: `❌ Gagal: ${e.message}` };
    }
  }

  // Chat tanpa tim terlihat: hanya /start, /gabung, dan perintah admin di
  // atas yang dilayani.
  if (!visible.length) return { reply: NOT_OWNER };

  const { team: activeTeam, visible: visibleList } = registry.resolveTeam(teams, chatId);
  if (!activeTeam) return { reply: NOT_OWNER };

  // /tim — daftar atau pindah tim aktif.
  if (cmd === "/tim") {
    const target = (rest[0] || "").toLowerCase();
    if (!target) return { reply: formatTeamList(visibleList, activeTeam.id) };
    const picked = visibleList.find((t) => t.id === target);
    if (!picked) return { reply: `Tim "${target}" tidak ada di daftar kamu. Kirim /tim untuk melihat tim yang bisa kamu akses.` };
    if (picked.status !== "active") return { reply: `Tim "${picked.name}" berstatus ${picked.status}, belum bisa dipakai.` };
    registry.setActiveTeam(chatId, picked.id);
    return { reply: `▶ Tim aktif sekarang: <b>${picked.name}</b> (<code>${picked.id}</code>). Perintah selanjutnya berlaku untuk tim ini.` };
  }

  // Perintah yang butuh tim target opsional: /status [tim], /tugas [tim].
  if (cmd === "/status" || cmd === "/tugas") {
    const team = pickTeam(rest[0], visibleList, activeTeam);
    if (typeof team === "string") return { reply: team }; // pesan error
    try {
      const state = await fetchState(team);
      return { reply: cmd === "/status" ? formatStatus(state, team) : formatTasks(state, team) };
    } catch (e) {
      return { reply: `❌ Gagal membaca status tim ${team.name}: ${e.message}` };
    }
  }

  if (cmd === "/help") return { reply: HELP_TEXT };

  if (cmd === "/pesan") {
    const body = rest.join(" ").trim();
    if (!body) return { reply: "Tulis pesannya: /pesan <teks>" };
    return relayToTeam(sendTeamMessage, activeTeam, "team", body, "ruang tim");
  }

  if (cmd === "/dm") {
    const target = (rest[0] || "").toLowerCase();
    const body = rest.slice(1).join(" ").trim();
    if (!body) return { reply: `Tulis pesannya: /dm ${target} <teks>` };
    // Validasi target ke daftar agent tim itu (dari state live; kalau
    // state tidak bisa dibaca, pakai daftar di registry). Server tetap
    // menegakkan daftarnya sendiri saat kirim.
    let knownAgents = activeTeam.agents || AGENT_IDS;
    try {
      const state = await fetchState(activeTeam);
      if (Array.isArray(state.agents) && state.agents.length) {
        knownAgents = state.agents.map((a) => String(a.id).toLowerCase());
      }
    } catch {
      // State tidak terbaca — lanjut dengan daftar registry.
    }
    if (!knownAgents.includes(target)) {
      return { reply: `Tujuan DM tidak dikenal di tim ${activeTeam.name}. Agent tim ini: ${knownAgents.join(", ")}. Contoh: /dm ${knownAgents[0] || "mas"} halo` };
    }
    return relayToTeam(sendTeamMessage, activeTeam, target, body, `DM ${agentName(target)}`);
  }

  if (cmd.startsWith("/")) {
    return { reply: "Perintah tidak dikenal. Ketik /help untuk daftar perintah." };
  }

  // Pesan biasa (bukan perintah) = kirim ke ruang tim aktif.
  // Catatan: di grup dengan privacy mode aktif, pesan biasa tidak sampai
  // ke bot — pakai perintah (/pesan ...) di grup.
  return relayToTeam(sendTeamMessage, activeTeam, "team", text, "ruang tim");
}

// Pilih tim dari argumen opsional (mis. /status kampung): kalau argumen
// cocok dengan id tim yang terlihat, pakai tim itu; kalau argumen ada tapi
// tidak cocok, kembalikan pesan error (string); kalau tidak ada argumen,
// pakai tim aktif.
function pickTeam(arg, visible, activeTeam) {
  if (!arg) return activeTeam;
  const team = visible.find((t) => t.id === String(arg).toLowerCase());
  if (!team) return `Tim "${arg}" tidak ada di daftar kamu. Kirim /tim untuk melihat tim yang bisa kamu akses.`;
  if (team.status !== "active") return `Tim "${team.name}" berstatus ${team.status}, belum bisa dipakai.`;
  return team;
}

async function relayToTeam(sendTeamMessage, team, to, body, destLabel) {
  try {
    await sendTeamMessage(team, to, `${EL_PREFIX}${body}`);
    return { reply: `✅ Terkirim ke ${destLabel} tim ${team.name}.` };
  } catch (e) {
    return { reply: `❌ Gagal kirim ke ${destLabel} tim ${team.name}: ${e.message}` };
  }
}

// /gabung <id-tim> <url-server> <kunci-agent> [nama-tim]
// Alur: validasi argumen → cek duplikat → verifikasi koneksi (GET state +
// /health + pesan jabat tangan yang memverifikasi kunci) → simpan ke
// registry dinamis → tim aktif (atau pending kalau REQUIRE_EL_APPROVAL).
// Kunci TIDAK PERNAH dimasukkan ke balasan/log.
async function handleJoin({ rest, chatId, chatType, fromId, messageId, registry, verifyTeamConnection, deleteMessage, ownerChatId }) {
  const [idRaw, urlRaw, keyRaw, ...nameParts] = rest;
  const isGroup = chatType === "group" || chatType === "supergroup";

  if (!registry.isDynamicEnabled()) {
    return {
      reply:
        `Pendaftaran tim lewat bot belum aktif — registry dinamis (Supabase) belum dikonfigurasi.\n\n` +
        `Minta EL mengaktifkan dulu (set SUPABASE_URL + SUPABASE_SERVICE_KEY di env bot + jalankan supabase-teams.sql), atau minta EL menambahkan timmu ke TEAMS_JSON.`,
    };
  }
  if (!idRaw || !urlRaw || !keyRaw) {
    return {
      reply:
        `Pakai: <code>/gabung &lt;id-tim&gt; &lt;url-server&gt; &lt;kunci-agent&gt; [nama-tim]</code>\n\n` +
        `Contoh: <code>/gabung kampung https://tim-kampung.vercel.app KUNCI-AGENT "Tim Kampung"</code>\n\n` +
        `Bot memverifikasi server itu dulu (cek /api/state + /health + satu pesan jabat tangan ke ruang tim untuk membuktikan kuncinya).`,
    };
  }

  const id = idRaw.toLowerCase();
  const serverUrl = urlRaw.replace(/\/+$/, "");
  const name = nameParts.join(" ").replace(/^"|"$/g, "").trim() || id;
  // Di grup, pemilik = user pengirim; notifikasi = grup itu. Di chat
  // pribadi, pemilik dan notifikasi = chat itu.
  const owner = isGroup ? String(fromId || chatId) : String(chatId);

  const candidate = {
    id,
    name,
    serverUrl,
    apiKey: keyRaw,
    fromAgent: "ell",
    agents: [...AGENT_IDS],
    ownerChatId: owner,
    notifyChatId: String(chatId),
    status: "active",
  };

  let verified;
  try {
    verified = await verifyTeamConnection(candidate);
  } catch (e) {
    return {
      reply:
        `❌ Verifikasi tim "${id}" gagal: ${e.message}\n\n` +
        `Cek lagi URL server dan kunci agent-nya. Kunci yang salah membuat jabat tangan ditolak (401) dan tim tidak terdaftar.`,
    };
  }
  candidate.fromAgent = verified.agentId;
  if (verified.agents?.length) candidate.agents = verified.agents;

  // Persetujuan EL (opsional, via env REQUIRE_EL_APPROVAL).
  const needsApproval = registry.requiresApproval ? registry.requiresApproval() : false;
  if (needsApproval) candidate.status = "pending";

  try {
    await registry.registerTeam(candidate);
  } catch (e) {
    return { reply: `❌ Tim "${id}" gagal didaftarkan: ${e.message}` };
  }

  // Hapus pesan /gabung berisi kunci (best-effort) + ingatkan pemilik.
  if (deleteMessage && messageId) {
    deleteMessage(chatId, messageId).catch(() => {});
  }

  if (needsApproval) {
    const reply =
      `✅ Tim <b>${name}</b> (<code>${id}</code>) terverifikasi dan terdaftar sebagai <b>pending</b>.\n\n` +
      `Menunggu persetujuan EL (/setuju ${id}). Setelah disetujui, notifikasi tim ini dikirim ke chat ini.\n\n` +
      `Hapus pesan /gabung tadi dari chat ini — pesannya berisi kunci agent timmu.`;
    const notify =
      owner !== String(ownerChatId)
        ? [{ chatId: ownerChatId, text: `🆕 Tim baru minta gabung: <b>${name}</b> (<code>${id}</code>), pemilik chat ${owner}. Setujui: /setuju ${id} — tolak: /tolak ${id}` }]
        : undefined;
    return { reply, notify };
  }

  const reply =
    `✅ Tim <b>${name}</b> (<code>${id}</code>) berhasil gabung!\n\n` +
    `Server terverifikasi, kunci agent terbukti sah (terhubung sebagai ${verified.agentId}). ` +
    `Notifikasi tim ini dikirim ke chat ini. Perintah: /status, /tugas, /pesan, /dm.\n\n` +
    `Hapus pesan /gabung tadi dari chat ini — pesannya berisi kunci agent timmu.`;
  const notify =
    owner !== String(ownerChatId)
      ? [{ chatId: ownerChatId, text: `🆕 Tim baru gabung: <b>${name}</b> (<code>${id}</code>), pemilik chat ${owner}, terhubung sebagai ${verified.agentId}.` }]
      : undefined;
  return { reply, notify };
}
