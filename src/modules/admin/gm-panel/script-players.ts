// GM panel client, part 3: Players list and player detail (tabs, moderation, edits, grants).
export const SCRIPT_PLAYERS = String.raw`
S.players = { filter: "all", q: "", sort: "lastLogin", dir: "desc", page: 1, pageSize: 25, data: null, cols: { guild: true, created: true, email: false } };
S.player = null;

function playerStatuses(row) {
  var list = [];
  if (row.banned) list.push({ tone: "bad", text: "Banned" });
  if (row.deletionScheduledAt) list.push({ tone: "warn", text: "Deletion pending" });
  if (row.muted) list.push({ tone: "warn", text: "Muted" });
  if (row.online) list.push({ tone: "ok", text: "Online" });
  if (row.isGuest) list.push({ tone: "", text: "Guest" });
  if (!list.length) list.push({ tone: "", text: "Offline" });
  return list;
}
function statusCell(row) {
  var list = playerStatuses(row);
  return statusDot(list[0].tone, list.map(function (s) { return s.text; }).join(", "));
}
function playerLink(userId, name) { return '<a data-act="go" data-to="#players/' + encodeURIComponent(userId) + '">' + esc(name) + "</a>"; }

// ── List ────────────────────────────────────────────────────────────
function renderPlayersTable() {
  var st = S.players, data = st.data;
  if (!data || !$("plTable")) return;
  $("plTabs").innerHTML = tabsHtml([
    { id: "all", label: "All", count: data.counts.all }, { id: "online", label: "Online", count: data.counts.online },
    { id: "banned", label: "Banned", count: data.counts.banned }, { id: "muted", label: "Muted", count: data.counts.muted },
    { id: "guests", label: "Guests", count: data.counts.guests }, { id: "deletion", label: "Deletion", count: data.counts.deletion },
    { id: "reported", label: "Reported", count: data.counts.reported }
  ], st.filter, "filterTab", ' data-scope="players"');
  if (!data.rows.length) { $("plTable").innerHTML = emptyHtml(st.q ? "No players match your search." : "No players in this tab."); return; }
  var c = st.cols;
  var head = sortTh("Player", "name", st, "players") + sortTh("Level", "level", st, "players", true) + (c.email ? "<th>Email</th>" : "") + (c.guild ? "<th>Guild</th>" : "") +
    sortTh("Last login", "lastLogin", st, "players") + (c.created ? sortTh("Created", "created", st, "players") : "") + "<th>Status</th>";
  var rows = data.rows.map(function (row) {
    return '<tr class="clickable" data-act="go" data-to="#players/' + encodeURIComponent(row.userId) + '"><td><a>' + esc(row.name || row.username) + "</a>" +
      '<div class="cell-sub">' + esc(row.username) + " - " + esc(shortId(row.userId)) + "</div></td>" +
      '<td class="num">' + (row.level === null ? "-" : fmtNum(row.level)) + "</td>" +
      (c.email ? "<td>" + esc(row.email || "-") + "</td>" : "") + (c.guild ? "<td>" + esc(row.guild || "-") + "</td>" : "") +
      "<td>" + esc(fmtAgo(row.lastLoginAt)) + "</td>" + (c.created ? "<td>" + esc(fmtDay(row.createdAt)) + "</td>" : "") + "<td>" + statusCell(row) + "</td></tr>";
  }).join("");
  $("plTable").innerHTML = '<div class="table-wrap"><table><thead><tr>' + head + "</tr></thead><tbody>" + rows + "</tbody></table></div>" + pagerHtml(st, data.total, "players");
}
LOADERS.players = async function () {
  var st = S.players;
  if (!$("plTable")) return;
  $("plTable").innerHTML = loadingHtml("Loading players...");
  try {
    st.data = await api("/admin/runtime/players" + qs({ filter: st.filter, q: st.q, sort: st.sort, dir: st.dir, page: st.page, pageSize: st.pageSize }));
  } catch (error) {
    $("plTable").innerHTML = errorHtml(error.message, "reload");
    return;
  }
  renderPlayersTable();
};
A.colsMenu = function () { $("plCols").classList.toggle("hidden"); };
A.colToggle = function (el) { S.players.cols[el.getAttribute("data-col")] = el.checked; renderPlayersTable(); };
A.playerFind = async function () {
  var values = await dialog({ title: "Look up player", fields: [{ name: "player", label: "Player", type: "lookup", placeholder: "Nickname, username, email or id" }], confirm: "Open" });
  if (!values || !values.player) return;
  go("#players/" + encodeURIComponent(values.player));
};

// ── Detail ──────────────────────────────────────────────────────────
var PLAYER_TABS = ["overview", "wallet", "monsters", "runes", "progress", "story", "connections", "reports", "audit"];
function kv(rows) {
  return '<dl class="kv">' + rows.map(function (r) { return "<dt>" + esc(r[0]) + "</dt><dd>" + (r[2] ? r[1] : esc(r[1] === null || r[1] === undefined || r[1] === "" ? "-" : r[1])) + "</dd>"; }).join("") + "</dl>";
}
function untilText(value) { return !value || isForever(value) ? "permanent" : "until " + fmtDate(value); }
function untilIso(seconds) { return Number(seconds) > 0 ? new Date(Date.now() + Number(seconds) * 1000).toISOString() : null; }
function parseAttachments(currencies, json) {
  var advanced = String(json || "").trim();
  if (advanced) { try { return JSON.parse(advanced); } catch (e) { throw new Error("Rewards JSON is invalid."); } }
  var list = String(currencies || "").split(",").map(function (p) { return p.trim(); }).filter(Boolean).map(function (part) {
    var pieces = part.split(":");
    var amount = Math.floor(num(pieces[1], 0));
    if (pieces.length !== 2 || !pieces[0].trim() || amount <= 0) throw new Error("Currencies must look like DM:100, GO:20000.");
    return { currencyId: pieces[0].trim(), amount: amount };
  });
  return list.length ? { currencies: list } : undefined;
}
var DURATIONS = [["600", "10 minutes"], ["3600", "1 hour"], ["86400", "1 day"], ["604800", "7 days"], ["2592000", "30 days"], ["0", "Permanent"]];

async function loadPlayerDetail(id, keepTab) {
  var data = await api(playerPath(id));
  var previous = S.player && S.player.id === data.player.account.userId ? S.player : null;
  S.player = { id: data.player.account.userId, d: data.player, audit: previous && keepTab ? previous.audit : { entries: [], done: false, loaded: false }, filter: previous ? previous.filter : "", tab: previous ? previous.tab : "overview" };
  return S.player;
}
async function reloadPlayer() { await loadPlayerDetail(S.player.id, true); renderPlayerPage(); }
async function playerAction(path, body, message, tone) {
  var data = await post(playerPath(S.player.id, path), body);
  toast(message, tone || "ok");
  if (data && S.player) await reloadPlayer();
  return data;
}

VIEWS.players = async function (r) {
  if (r.id) {
    content().innerHTML = loadingHtml("Loading player...");
    try {
      await loadPlayerDetail(r.id, false);
    } catch (error) {
      content().innerHTML = pageHead("Player", "", "", '<div class="crumb"><a data-act="go" data-to="#players">Players</a></div>') + '<div class="panel">' + errorHtml(error.message, "reload") + "</div>";
      return;
    }
    S.player.tab = PLAYER_TABS.indexOf(r.tab) >= 0 ? r.tab : "overview";
    renderPlayerPage();
    return;
  }
  var st = S.players, c = st.cols;
  var columns = '<div class="rel"><button class="link-btn" data-act="colsMenu">' + icon("columns", 18) + 'Columns</button><div class="menu hidden" id="plCols">' +
    '<label><input type="checkbox" data-change="colToggle" data-col="email"' + (c.email ? " checked" : "") + " /> Email</label>" +
    '<label><input type="checkbox" data-change="colToggle" data-col="guild"' + (c.guild ? " checked" : "") + " /> Guild</label>" +
    '<label><input type="checkbox" data-change="colToggle" data-col="created"' + (c.created ? " checked" : "") + " /> Created</label></div></div>";
  content().innerHTML = pageHead("Players", "", '<button class="btn primary" data-act="playerFind">Look up player</button>') +
    '<div class="panel"><div id="plTabs"></div>' + searchRow("players", "Search by name, username, email or id", st.q, columns) + '<div id="plTable"></div></div>';
  LOADERS.players();
};

function renderPlayerPage() {
  var p = S.player, d = p.d, a = d.account, tab = p.tab;
  var name = d.profile ? d.profile.name : a.username;
  var statuses = playerStatuses({ banned: a.ban && a.ban.active, muted: a.chatMute && a.chatMute.active, deletionScheduledAt: a.deletionScheduledAt, online: d.online, isGuest: a.isGuest });
  var sub = statuses.map(function (s) { return statusDot(s.tone, s.text); }).join(" &nbsp; ") + ' &nbsp; <span class="muted">' + esc(a.username) + " - </span>" +
    '<a data-act="copy" data-text="' + esc(a.userId) + '" title="Copy user id"><span class="mono">' + esc(a.userId) + "</span></a>";
  var banned = a.ban && a.ban.active, muted = a.chatMute && a.chatMute.active;
  var actions = '<button class="btn primary" data-act="pMail">Send mail</button><button class="btn" data-act="pRename">Rename</button>' +
    '<button class="btn text red" data-act="pKick">Kick</button>' +
    (banned ? '<button class="btn" data-act="pUnban">Unban</button>' : '<button class="btn text red" data-act="pBan">Ban</button>') +
    (muted ? '<button class="btn" data-act="pUnmute">Unmute</button>' : '<button class="btn text red" data-act="pMute">Mute</button>') +
    '<button class="btn text red" data-act="pRevoke">Sign out devices</button>';
  var tabs = tabsHtml([
    { id: "overview", label: "Overview" }, { id: "wallet", label: "Wallet" }, { id: "monsters", label: "Monsters", count: d.roster.units.length },
    { id: "runes", label: "Runes", count: d.runes.total }, { id: "progress", label: "Progress" }, { id: "story", label: "Story", count: d.story.completed.length },
    { id: "connections", label: "Connections", count: d.connections.length }, { id: "reports", label: "Reports" }, { id: "audit", label: "Audit" }
  ], tab, "pTab");
  content().innerHTML = pageHead(name, sub, actions, '<div class="crumb"><a data-act="go" data-to="#players">Players</a></div>') +
    '<div class="panel">' + tabs + '<div id="pBody"></div></div>';
  renderPlayerTab();
}
A.pTab = function (el) { S.player.filter = ""; go("#players/" + encodeURIComponent(S.player.id) + "/" + el.getAttribute("data-tab")); };

function renderPlayerTab() {
  var p = S.player, d = p.d, body = $("pBody");
  var render = { overview: tabOverview, wallet: tabWallet, monsters: tabMonsters, runes: tabRunes, progress: tabProgress, story: tabStory, connections: tabConnections, reports: tabReports, audit: tabAudit }[p.tab];
  body.innerHTML = render(d);
  if (p.tab === "reports" && !p.reports) loadPlayerReports();
  if (p.tab === "audit" && !p.audit.loaded) loadAudit(false);
}
function block(title, inner, actions) {
  return '<div class="panel" style="border:0;border-top:1px solid var(--line);border-radius:0"><div class="panel-head" style="border:0"><h2>' + esc(title) + "</h2><div>" + (actions || "") + '</div></div><div class="panel-body" style="padding-top:0">' + inner + "</div></div>";
}
function tabOverview(d) {
  var a = d.account, pr = d.profile, banner = "";
  if (a.ban && a.ban.active) banner += '<div class="banner bad" style="margin:20px 24px 0"><strong>Banned</strong> ' + esc(untilText(a.ban.until)) + (a.ban.reason ? " - " + esc(a.ban.reason) : "") + "</div>";
  if (a.chatMute && a.chatMute.active) banner += '<div class="banner warn" style="margin:12px 24px 0"><strong>Chat muted</strong> ' + esc(untilText(a.chatMute.until)) + (a.chatMute.reason ? " - " + esc(a.chatMute.reason) : "") + "</div>";
  if (a.deletionScheduledAt) banner += '<div class="banner warn" style="margin:12px 24px 0"><strong>Account deletion</strong> scheduled for ' + esc(fmtDate(a.deletionScheduledAt)) + "</div>";
  var guild = d.guild
    ? kv([["Guild", '<a data-act="go" data-to="#guilds/' + encodeURIComponent(d.guild.guildId) + '">' + esc(d.guild.name) + "</a>", true], ["Role", d.guild.role], ["Joined", fmtDate(d.guild.joinedAt)]]) +
      '<div style="margin-top:14px"><button class="btn red" data-act="pGuildRemove">Remove from guild</button></div>'
    : '<span class="muted">Not in a guild.</span>';
  var arena = d.arena
    ? kv([["Rating", fmtNum(d.arena.rating)], ["Record", d.arena.wins + " W / " + d.arena.losses + " L"], ["Defense", d.arena.defenseWins + " W / " + d.arena.defenseLosses + " L"], ["Season", d.arena.season + " (" + d.arena.seasonBattles + " battles)"]])
    : '<span class="muted">No arena profile.</span>';
  return banner + '<div class="grid2" style="padding:20px 24px"><div class="stack"><div class="panel"><div class="panel-head"><h2>Account</h2></div><div class="panel-body">' + kv([
    ["User id", a.userId], ["Username", a.username], ["Email", a.email || "-"], ["Type", a.isGuest ? "Guest" : "Registered"], ["Created", fmtDate(a.createdAt)],
    ["Last login", fmtDate(a.lastLoginAt)], ["Failed logins", a.failedLogins], ["Locked until", a.lockedUntil ? fmtDate(a.lockedUntil) : "-"]
  ]) + '</div></div></div><div class="stack"><div class="panel"><div class="panel-head"><h2>Profile</h2><button class="btn small" data-act="pLevel">Set level</button></div><div class="panel-body">' +
    (pr ? kv([["Nickname", pr.name], ["Level", pr.level], ["EXP", fmtNum(pr.currentExp)], ["Icon", pr.iconId]]) : '<span class="muted">No profile yet.</span>') +
    '</div></div><div class="panel"><div class="panel-head"><h2>Guild</h2></div><div class="panel-body">' + guild +
    '</div></div><div class="panel"><div class="panel-head"><h2>Arena</h2></div><div class="panel-body">' + arena + "</div></div></div></div>";
}
function tabWallet(d) {
  var ids = Object.keys(d.wallet).sort();
  var rows = ids.map(function (id) {
    return "<tr><td><strong>" + esc(id) + '</strong></td><td class="num">' + fmtNum(d.wallet[id]) + '</td><td class="num"><button class="btn text" data-act="pSetCurrency" data-id="' + esc(id) + '">Set balance</button></td></tr>';
  }).join("");
  return '<div class="panel-head" style="border:0"><h2>Balances</h2><button class="btn primary" data-act="pGrantCurrency">Grant currency</button></div>' +
    (ids.length ? '<div class="table-wrap"><table><thead><tr><th>Currency</th><th class="num">Balance</th><th></th></tr></thead><tbody>' + rows + "</tbody></table></div>" : emptyHtml("No balances."));
}
function tabMonsters(d) {
  var f = S.player.filter.toLowerCase();
  var units = d.roster.units.filter(function (u) { return !f || u.characterId.toLowerCase().indexOf(f) >= 0; });
  var rows = units.map(function (u) {
    return "<tr><td><strong>" + esc(u.characterId) + '</strong><div class="cell-sub mono">' + esc(shortId(u.uid)) + '</div></td><td class="num">' + u.stars + '</td><td class="num">' + u.level +
      '</td><td class="num">' + u.awakeningIndex + "</td><td>" + esc(u.location) + '</td><td class="num">' + u.runes + "</td><td>" + (u.locked ? "Locked" : "") +
      '</td><td class="num nowrap"><button class="btn text" data-act="pUnitEdit" data-uid="' + esc(u.uid) + '">Edit</button><button class="btn text red" data-act="pUnitDelete" data-uid="' + esc(u.uid) + '">Delete</button></td></tr>';
  }).join("");
  return '<div class="panel-head" style="border:0"><h2>' + fmtNum(d.roster.units.length) + " monsters - bag " + d.roster.bagCapacity + ", storage " + d.roster.storageCapacity +
    '</h2><button class="btn primary" data-act="pGrantCharacter">Grant monster</button></div>' +
    '<div class="searchrow" style="height:56px;border-top:1px solid var(--line)">' + icon("search", 20) + '<input type="search" id="pUnitFilter" data-input-act="pFilter" placeholder="Filter by character id" value="' + esc(S.player.filter) + '" /></div>' +
    (units.length ? '<div class="table-wrap"><table><thead><tr><th>Character</th><th class="num">Stars</th><th class="num">Level</th><th class="num">Awakening</th><th>Location</th><th class="num">Runes</th><th>Flags</th><th></th></tr></thead><tbody>' + rows + "</tbody></table></div>" : emptyHtml("No monsters."));
}
A.pFilter = function (el) { S.player.filter = el.value; renderPlayerTab(); var box = $("pUnitFilter") || $("pRuneFilter"); if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); } };
function tabRunes(d) {
  var f = S.player.filter.toLowerCase();
  var items = d.runes.items.filter(function (r) { return !f || r.setId.toLowerCase().indexOf(f) >= 0; });
  var rows = items.map(function (r) {
    return "<tr><td><strong>" + esc(r.setId) + '</strong><div class="cell-sub mono">' + esc(shortId(r.uid)) + '</div></td><td class="num">' + r.slot + '</td><td class="num">' + r.tier + '</td><td class="num">' + r.quality +
      '</td><td class="num">' + r.level + "</td><td>" + esc(r.mainStatType) + " " + esc(r.mainStatValue) + "</td><td>" + (r.equippedToUid ? '<span class="mono">' + esc(shortId(r.equippedToUid)) + "</span>" : "-") +
      '</td><td class="num"><button class="btn text red" data-act="pRuneDelete" data-uid="' + esc(r.uid) + '">Delete</button></td></tr>';
  }).join("");
  return '<div class="panel-head" style="border:0"><h2>' + fmtNum(d.runes.total) + " / " + fmtNum(d.runes.capacity) + ' runes</h2><button class="btn primary" data-act="pGrantRune">Grant rune</button></div>' +
    '<div class="searchrow" style="height:56px;border-top:1px solid var(--line)">' + icon("search", 20) + '<input type="search" id="pRuneFilter" data-input-act="pFilter" placeholder="Filter by set" value="' + esc(S.player.filter) + '" /></div>' +
    (items.length ? '<div class="table-wrap"><table><thead><tr><th>Set</th><th class="num">Slot</th><th class="num">Tier</th><th class="num">Quality</th><th class="num">Level</th><th>Main stat</th><th>Equipped to</th><th></th></tr></thead><tbody>' + rows + "</tbody></table></div>" : emptyHtml("No runes."))
    + (d.runes.total > d.runes.items.length ? '<div class="pager"><span>Showing the first ' + fmtNum(d.runes.items.length) + " runes.</span></div>" : "");
}
function tabProgress(d) {
  var stages = d.stages.map(function (s) { return "<tr><td>" + esc(s.regionId) + "</td><td>" + esc(s.difficulty) + '</td><td class="num">' + fmtNum(s.cleared) + '</td><td class="num">' + fmtNum(s.clears) + "</td></tr>"; }).join("");
  var towers = d.towers.map(function (t) { return "<tr><td>" + esc(t.regionId) + "</td><td>" + esc(t.seasonKey) + '</td><td class="num">' + fmtNum(t.clearedFloors) + "</td></tr>"; }).join("");
  return '<div class="grid2" style="padding:20px 24px"><div class="panel"><div class="panel-head"><h2>Stages</h2></div>' +
    (stages ? '<div class="table-wrap"><table><thead><tr><th>Region</th><th>Difficulty</th><th class="num">Stages cleared</th><th class="num">Clears</th></tr></thead><tbody>' + stages + "</tbody></table></div>" : emptyHtml("No stage progress.")) +
    '</div><div class="panel"><div class="panel-head"><h2>Towers</h2></div>' +
    (towers ? '<div class="table-wrap"><table><thead><tr><th>Region</th><th>Season</th><th class="num">Floors</th></tr></thead><tbody>' + towers + "</tbody></table></div>" : emptyHtml("No tower progress.")) + "</div></div>";
}
function tabStory(d) {
  var rows = d.story.completed.map(function (s) {
    return "<tr><td><strong>" + esc(s.dialogueId) + "</strong></td><td>" + (s.skipped ? "Skipped" : "Played") + '</td><td class="num">' + s.times + "</td><td>" + esc(fmtDate(s.completedAt)) + "</td></tr>";
  }).join("");
  return '<div class="panel-head" style="border:0"><h2>' + (d.story.active ? "In progress: " + esc(d.story.active.dialogueId) + " (step " + d.story.active.step + ")" : "Completed sequences") +
    '</h2><button class="btn red" data-act="pStoryReset">Reset story</button></div>' +
    (rows ? '<div class="table-wrap"><table><thead><tr><th>Sequence</th><th>Result</th><th class="num">Times</th><th>Completed</th></tr></thead><tbody>' + rows + "</tbody></table></div>" : emptyHtml("No completed sequences."));
}
function tabConnections(d) {
  var rows = d.connections.map(function (c) {
    // Rows never closed (crash/restart) stay here; only a heartbeat in the last minute counts as live.
    var stale = Date.now() - Date.parse(c.lastHeartbeatAt) > 60000;
    return "<tr><td><strong>" + esc(c.room) + '</strong></td><td class="mono">' + esc(c.deviceId) + "</td><td>" + esc(fmtDate(c.connectedAt)) + "</td><td>" + esc(fmtAgo(c.lastHeartbeatAt)) + (stale ? ' <span class="cell-sub">(stale)</span>' : "") + "</td><td>" + esc(c.ip || "-") + '</td><td class="cell-sub">' + esc(c.userAgent || "-") + "</td></tr>";
  }).join("");
  return '<div class="panel-head" style="border:0"><h2>Open connections</h2><button class="btn red" data-act="pRevoke">Sign out all devices</button></div>' +
    (rows ? '<div class="table-wrap"><table><thead><tr><th>Room</th><th>Device</th><th>Connected</th><th>Last heartbeat</th><th>IP</th><th>Client</th></tr></thead><tbody>' + rows + "</tbody></table></div>" : emptyHtml("No open connections."));
}
function auditRows(entries) {
  return entries.map(function (e) {
    var meta = e.meta === null || e.meta === undefined ? "" : JSON.stringify(e.meta);
    return '<tr><td class="mono">' + e.id + "</td><td class=\"nowrap\">" + esc(fmtDate(e.createdAt)) + "</td><td><strong>" + esc(e.kind) + '</strong></td><td class="cell-sub" style="max-width:560px;overflow-wrap:anywhere">' + esc(meta.length > 320 ? meta.slice(0, 320) + "..." : meta) + "</td></tr>";
  }).join("");
}
function tabAudit() {
  var au = S.player.audit;
  return '<div id="pAudit">' + (au.loaded ? auditTable(au) : loadingHtml("Loading audit trail...")) + "</div>";
}
function auditTable(au) {
  if (!au.entries.length) return emptyHtml("No audit entries.");
  return '<div class="table-wrap"><table><thead><tr><th>Id</th><th>When</th><th>Kind</th><th>Details</th></tr></thead><tbody>' + auditRows(au.entries) + "</tbody></table></div>" +
    (au.done ? "" : '<div class="pager"><span></span><button class="btn small" data-act="pAuditMore">Load older</button></div>');
}
async function loadAudit(more) {
  var au = S.player.audit;
  var before = more && au.entries.length ? au.entries[au.entries.length - 1].id : null;
  try {
    var data = await api(playerPath(S.player.id, "audit") + qs({ limit: 50, before: before }));
    au.entries = more ? au.entries.concat(data.entries) : data.entries;
    au.done = data.entries.length < 50;
    au.loaded = true;
    if ($("pAudit")) $("pAudit").innerHTML = auditTable(au);
  } catch (error) { if ($("pAudit")) $("pAudit").innerHTML = errorHtml(error.message); }
}
A.pAuditMore = function () { return loadAudit(true); };

// ── Player actions ──────────────────────────────────────────────────
function reasonField() { return { name: "reason", label: "Reason", type: "text", maxlength: 160, placeholder: "Optional, kept in the audit trail" }; }
A.pRename = async function () {
  var v = await dialog({ title: "Rename player", text: "Same rules as the in-game rename (length, characters, unique name).", fields: [{ name: "nickname", label: "New nickname", type: "text", value: S.player.d.profile ? S.player.d.profile.name : "", maxlength: 32 }, reasonField()], confirm: "Rename" });
  if (v) await playerAction("rename", { nickname: v.nickname, reason: v.reason || undefined }, "Player renamed.");
};
A.pMail = async function () {
  var v = await dialog({ title: "Send mail", wide: true, text: "Lands in the player mailbox. Rewards are granted when the player claims them.", fields: [
    { name: "title", label: "Title", type: "text", maxlength: 80 }, { name: "body", label: "Message", type: "textarea", maxlength: 1000 },
    { name: "sender", label: "Sender", type: "text", value: "Game Master", maxlength: 32 }, { name: "expirationDays", label: "Expires in days (0 = never)", type: "number", value: 30, min: 0, max: 3650 },
    { name: "currencies", label: "Currencies (id:amount, comma separated)", type: "text", placeholder: "DM:100, GO:20000" },
    { name: "json", label: "Advanced rewards JSON (replaces the currencies)", type: "textarea", placeholder: "{\"runes\":[{\"tier\":6,\"quantity\":1}]}" }, reasonField()
  ], confirm: "Send" });
  if (!v) return;
  if (!v.title) throw new Error("Mail title is required.");
  await playerAction("mail", { title: v.title, body: v.body || undefined, sender: v.sender || undefined, expirationDays: v.expirationDays === null ? undefined : v.expirationDays, attachments: parseAttachments(v.currencies, v.json), reason: v.reason || undefined }, "Mail sent.");
};
A.pKick = async function () {
  var v = await dialog({ title: "Kick player", text: "Closes every live connection. The player may log in again.", fields: [{ name: "reason", label: "Reason shown to the player", type: "text", maxlength: 255 }], confirm: "Kick", danger: true });
  if (v) await playerAction("kick", { reason: v.reason || undefined }, "Player kicked.", "warn");
};
A.pBan = async function () {
  var v = await dialog({ title: "Ban player", text: "Revokes every token and disconnects the player. Login is refused until the ban ends.", fields: [{ name: "duration", label: "Duration", type: "select", value: "86400", options: DURATIONS }, { name: "reason", label: "Reason", type: "text", maxlength: 255 }], confirm: "Ban", danger: true });
  if (v) await playerAction("ban", { until: untilIso(v.duration), reason: v.reason || undefined }, "Player banned.", "warn");
};
A.pUnban = async function () { if (await confirmAction("Unban player", "The player can log in again.", "Unban", false)) await playerAction("unban", {}, "Player unbanned."); };
A.pMute = async function () {
  var v = await dialog({ title: "Mute in chat", text: "Blocks every chat channel (global and guild).", fields: [{ name: "duration", label: "Duration", type: "select", value: "3600", options: DURATIONS }, { name: "reason", label: "Reason", type: "text", maxlength: 255 }], confirm: "Mute", danger: true });
  if (v) await playerAction("mute", { until: untilIso(v.duration), reason: v.reason || undefined }, "Player muted.", "warn");
};
A.pUnmute = async function () { if (await confirmAction("Unmute player", "The player can chat again.", "Unmute", false)) await playerAction("unmute", {}, "Player unmuted."); };
A.pRevoke = async function () {
  if (await confirmAction("Sign out all devices", "Every session and refresh token is revoked and live connections are closed. The player can log in again.", "Sign out")) {
    await playerAction("sessions/revoke", {}, "All devices signed out.", "warn");
  }
};
A.pLevel = async function () {
  var v = await dialog({ title: "Set account level", text: "EXP goes back to 0 and no level-up rewards are granted.", fields: [{ name: "level", label: "Level", type: "number", value: S.player.d.profile ? S.player.d.profile.level : 1, min: 1, max: 999 }, reasonField()], confirm: "Set level" });
  if (v && v.level) await playerAction("level", { level: v.level, reason: v.reason || undefined }, "Level updated.");
};
A.pSetCurrency = async function (el) {
  var id = el.getAttribute("data-id");
  var v = await dialog({ title: "Set " + id + " balance", text: "Sets an exact balance. A raise stops at the cap of currencies that cannot overflow.", fields: [{ name: "amount", label: "New balance", type: "number", value: S.player.d.wallet[id], min: 0, max: 2000000000 }, reasonField()], confirm: "Set balance" });
  if (v && v.amount !== null) await playerAction("currency", { currencyId: id, amount: v.amount, reason: v.reason || undefined }, "Balance updated.");
};
A.pGuildRemove = async function () {
  if (await confirmAction("Remove from guild", "A leader hands the lead to the oldest officer or member; the guild is deleted when nobody else is left.", "Remove")) {
    await playerAction("guild/remove", {}, "Player removed from the guild.", "warn");
  }
};
A.pStoryReset = async function () {
  var catalog = await loadCatalog();
  var v = await dialog({ title: "Reset story", text: "Forgets completed sequences so they play again (their rewards can be earned again).", fields: [
    { name: "scope", label: "Scope", type: "select", value: "all", options: [["all", "All story and tutorial"], ["tutorial", "Tutorial only (tutorial_*)"], ["story", "Story only (story_*)"], ["ids", "Chosen ids"]] },
    { name: "ids", label: "Ids (comma separated, used by Chosen ids)", type: "text", placeholder: (catalog && catalog.dialogues.slice(0, 2).join(", ")) || "" }
  ], confirm: "Reset", danger: true });
  if (!v) return;
  var scope = v.scope;
  if (scope === "ids") {
    scope = v.ids.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    if (!scope.length) throw new Error("Enter at least one dialogue id.");
  }
  var data = await playerAction("story/reset", { scope: scope }, "Story reset.", "warn");
  if (data) toast(fmtNum(data.removed) + " sequence(s) removed.", "ok");
};
A.pUnitEdit = async function (el) {
  var unit = S.player.d.roster.units.filter(function (u) { return u.uid === el.getAttribute("data-uid"); })[0];
  var v = await dialog({ title: "Edit " + unit.characterId, text: "Changing the stars resets the level (set both to choose). The level must fit the star tier.", fields: [
    { name: "stars", label: "Stars", type: "number", value: unit.stars, min: 1, max: 6 }, { name: "level", label: "Level", type: "number", value: unit.level, min: 1, max: 999 }, reasonField()
  ], confirm: "Save" });
  if (!v) return;
  var body = { reason: v.reason || undefined };
  if (v.stars !== unit.stars) body.stars = v.stars;
  if (v.level !== unit.level || v.stars !== unit.stars) body.level = v.level;
  await playerAction("units/" + encodeURIComponent(unit.uid) + "/set", body, "Monster updated.");
};
A.pUnitDelete = async function (el) {
  var unit = S.player.d.roster.units.filter(function (u) { return u.uid === el.getAttribute("data-uid"); })[0];
  if (await confirmAction("Delete " + unit.characterId, "The monster is removed for good (" + unit.stars + " stars, level " + unit.level + "). Its runes go back to the inventory.", "Delete")) {
    await playerAction("units/" + encodeURIComponent(unit.uid) + "/delete", {}, "Monster deleted.", "warn");
  }
};
A.pRuneDelete = async function (el) {
  var rune = S.player.d.runes.items.filter(function (r) { return r.uid === el.getAttribute("data-uid"); })[0];
  if (await confirmAction("Delete rune", rune.setId + " rune, slot " + rune.slot + ", level " + rune.level + ". No refund.", "Delete")) {
    await playerAction("runes/" + encodeURIComponent(rune.uid) + "/delete", {}, "Rune deleted.", "warn");
  }
};

// Grants (also used by the Grants view with its own target).
async function grantCurrencyDialog(target) {
  await loadCatalog();
  var v = await dialog({ title: "Grant currency", text: "Adds to the balance and pushes the wallet to the player if online.", fields: [
    { name: "currencyId", label: "Currency", type: "text", list: "dlCurrencies", placeholder: "GO, DM, energy" }, { name: "amount", label: "Amount", type: "number", value: 100, min: 1, max: 1000000000 }, reasonField()
  ], confirm: "Grant" });
  if (!v) return null;
  var data = await post("/admin/runtime/grant/currency", { target: target, currencyId: v.currencyId, amount: v.amount, reason: v.reason || undefined });
  toast("Granted " + fmtNum(v.amount) + " " + v.currencyId + " to " + data.target.username + ".", "ok");
  return data;
}
async function grantCharacterDialog(target) {
  await loadCatalog();
  var v = await dialog({ title: "Grant monster", text: "Creates new monsters in the bag or storage.", fields: [
    { name: "characterId", label: "Character id", type: "text", list: "dlCharacters" }, { name: "copies", label: "Copies", type: "number", value: 1, min: 1, max: 100 },
    { name: "targetLocation", label: "Location", type: "select", value: "BAG", options: [["BAG", "Bag"], ["STORAGE", "Storage"]] },
    { name: "stars", label: "Stars (empty = natural)", type: "number", min: 1, max: 6 }, { name: "level", label: "Level", type: "number", value: 1, min: 1, max: 99 },
    { name: "awakeningIndex", label: "Awakening index", type: "number", value: 0, min: 0, max: 12 }, reasonField()
  ], confirm: "Grant" });
  if (!v) return null;
  var body = { target: target, characterId: v.characterId, copies: v.copies || 1, targetLocation: v.targetLocation, level: v.level || 1, awakeningIndex: v.awakeningIndex || 0, reason: v.reason || undefined };
  if (v.stars) body.stars = v.stars;
  var data = await post("/admin/runtime/grant/character", body);
  toast("Granted " + fmtNum((data.characters || []).length) + " monster(s) to " + data.target.username + ".", "ok");
  return data;
}
async function grantRuneDialog(target) {
  await loadCatalog();
  var v = await dialog({ title: "Grant rune", text: "Generates runes in the player inventory.", fields: [
    { name: "setId", label: "Set", type: "text", list: "dlRuneSets" }, { name: "copies", label: "Copies", type: "number", value: 1, min: 1, max: 100 },
    { name: "slot", label: "Slot", type: "number", value: 2, min: 1, max: 6 }, { name: "tier", label: "Tier", type: "number", value: 6, min: 1, max: 6 },
    { name: "quality", label: "Quality", type: "number", value: 5, min: 1, max: 5 }, { name: "level", label: "Level", type: "number", value: 0, min: 0, max: 15 },
    { name: "variant", label: "Variant", type: "text", value: "Normal" }, { name: "mainStatType", label: "Main stat (optional)", type: "text" }, reasonField()
  ], confirm: "Grant" });
  if (!v) return null;
  var body = { target: target, setId: v.setId, copies: v.copies || 1, slot: v.slot, tier: v.tier, quality: v.quality, level: v.level || 0, variant: v.variant || "Normal", origin: "gm_panel", reason: v.reason || undefined };
  if (v.mainStatType) body.mainStatType = v.mainStatType;
  var data = await post("/admin/runtime/grant/rune", body);
  toast("Granted " + fmtNum((data.runes || []).length) + " rune(s) to " + data.target.username + ".", "ok");
  return data;
}
A.pGrantCurrency = async function () { if (await grantCurrencyDialog(S.player.id)) await reloadPlayer(); };
A.pGrantCharacter = async function () { if (await grantCharacterDialog(S.player.id)) await reloadPlayer(); };
A.pGrantRune = async function () { if (await grantRuneDialog(S.player.id)) await reloadPlayer(); };
`;
