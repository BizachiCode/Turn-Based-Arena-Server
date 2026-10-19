// GM panel client, part 4: Guilds, Chat moderation, Mail (compose + history), Audit log, Config and Grants.
export const SCRIPT_COMMUNITY = String.raw`
// ── Guilds ──────────────────────────────────────────────────────────
S.guilds = { filter: "all", q: "", sort: "members", dir: "desc", page: 1, pageSize: 25, data: null };
S.guild = null;

function renderGuildsTable() {
  var st = S.guilds, data = st.data;
  if (!data || !$("guTable")) return;
  $("guTabs").innerHTML = tabsHtml([
    { id: "all", label: "All", count: data.counts.all }, { id: "open", label: "Open", count: data.counts.open }, { id: "approval", label: "Approval", count: data.counts.approval }
  ], st.filter, "filterTab", ' data-scope="guilds"');
  if (!data.rows.length) { $("guTable").innerHTML = emptyHtml(st.q ? "No guilds match your search." : "No guilds yet."); return; }
  var head = sortTh("Guild", "name", st, "guilds") + "<th>Leader</th>" + sortTh("Members", "members", st, "guilds", true) + sortTh("Min level", "minLevel", st, "guilds", true) +
    "<th>Join</th>" + sortTh("Activity", "activity", st, "guilds", true) + sortTh("Created", "created", st, "guilds");
  var rows = data.rows.map(function (g) {
    return '<tr class="clickable" data-act="go" data-to="#guilds/' + encodeURIComponent(g.guildId) + '"><td><a>' + esc(g.name) + '</a><div class="cell-sub mono">' + esc(shortId(g.guildId)) + "</div></td>" +
      "<td>" + esc(g.leaderName || "-") + '</td><td class="num">' + fmtNum(g.memberCount) + '</td><td class="num">' + fmtNum(g.minLevel) + "</td><td>" + (g.joinType === "open" ? "Open" : "Approval") +
      '</td><td class="num">' + fmtNum(g.activityPoints) + "</td><td>" + esc(fmtDay(g.createdAt)) + "</td></tr>";
  }).join("");
  $("guTable").innerHTML = '<div class="table-wrap"><table><thead><tr>' + head + "</tr></thead><tbody>" + rows + "</tbody></table></div>" + pagerHtml(st, data.total, "guilds");
}
LOADERS.guilds = async function () {
  var st = S.guilds;
  if (!$("guTable")) return;
  $("guTable").innerHTML = loadingHtml("Loading guilds...");
  try {
    st.data = await api("/admin/runtime/guilds" + qs({ filter: st.filter, q: st.q, sort: st.sort, dir: st.dir, page: st.page, pageSize: st.pageSize }));
  } catch (error) {
    $("guTable").innerHTML = errorHtml(error.message, "reload");
    return;
  }
  renderGuildsTable();
};
async function loadGuildDetail(id) {
  var data = await api("/admin/runtime/guilds/" + encodeURIComponent(id));
  S.guild = data.detail;
}
function renderGuildPage() {
  var d = S.guild, g = d.guild;
  var actions = '<button class="btn primary" data-act="gEdit">Edit</button><button class="btn text red" data-act="gDisband">Disband</button>';
  var rows = d.members.map(function (m) {
    var manage = m.role === "leader" ? "" : '<button class="btn text" data-act="gLeader" data-id="' + esc(m.publicId) + '" data-name="' + esc(m.name || "") + '">Make leader</button>' +
      '<button class="btn text red" data-act="gKick" data-id="' + esc(m.publicId) + '" data-name="' + esc(m.name || "") + '">Kick</button>';
    return "<tr><td>" + (m.name ? playerLink(m.userId, m.name) : '<span class="muted">' + esc(shortId(m.userId)) + "</span>") + "</td><td>" + esc(m.role) + '</td><td class="num">' + (m.level === null ? "-" : m.level) +
      "</td><td>" + esc(fmtDay(m.joinedAt)) + "</td><td>" + esc(fmtAgo(m.lastLoginAt)) + '</td><td class="num nowrap">' + manage + "</td></tr>";
  }).join("");
  content().innerHTML = pageHead(g.name, "<span class=\"mono\">" + esc(g.guildId) + "</span>", actions, '<div class="crumb"><a data-act="go" data-to="#guilds">Guilds</a></div>') +
    '<div class="grid2"><div class="panel"><div class="panel-head"><h2>Details</h2></div><div class="panel-body">' + kv([
      ["Leader", g.leaderUserId ? playerLink(g.leaderUserId, g.leaderName || shortId(g.leaderUserId)) : "-", true], ["Members", g.memberCount], ["Join type", g.joinType === "open" ? "Open" : "Approval required"],
      ["Min level", g.minLevel], ["Pending requests", d.pendingRequests], ["Activity points", fmtNum(g.activityPoints)], ["Tags", g.tags.length ? g.tags.join(", ") : "-"], ["Created", fmtDate(g.createdAt)]
    ]) + '</div></div><div class="panel"><div class="panel-head"><h2>Texts</h2></div><div class="panel-body">' + kv([["Description", g.description || "-"], ["Notice", g.notice || "-"], ["Emblem", g.iconId]]) + "</div></div></div>" +
    '<div class="panel" style="margin-top:16px"><div class="panel-head"><h2>Members</h2></div><div class="table-wrap"><table><thead><tr><th>Player</th><th>Role</th><th class="num">Level</th><th>Joined</th><th>Last login</th><th></th></tr></thead><tbody>' + rows + "</tbody></table></div></div>";
}
VIEWS.guilds = async function (r) {
  if (r.id) {
    content().innerHTML = loadingHtml("Loading guild...");
    try { await loadGuildDetail(r.id); } catch (error) {
      content().innerHTML = pageHead("Guild", "", "", '<div class="crumb"><a data-act="go" data-to="#guilds">Guilds</a></div>') + '<div class="panel">' + errorHtml(error.message, "reload") + "</div>";
      return;
    }
    renderGuildPage();
    return;
  }
  content().innerHTML = pageHead("Guilds", "") + '<div class="panel"><div id="guTabs"></div>' + searchRow("guilds", "Search guilds by name or id", S.guilds.q) + '<div id="guTable"></div></div>';
  LOADERS.guilds();
};
async function guildAction(path, body, message, back) {
  await post("/admin/runtime/guilds/" + encodeURIComponent(S.guild.guild.guildId) + "/" + path, body);
  toast(message, "ok");
  if (back) go("#guilds"); else { await loadGuildDetail(S.guild.guild.guildId); renderGuildPage(); }
}
A.gEdit = async function () {
  var g = S.guild.guild;
  var v = await dialog({ title: "Edit guild", text: "The name follows the same rules as guild creation and must be unique.", fields: [
    { name: "name", label: "Name", type: "text", value: g.name, maxlength: 32 }, { name: "description", label: "Description", type: "textarea", value: g.description, maxlength: 255 },
    { name: "notice", label: "Notice", type: "textarea", value: g.notice, maxlength: 255 }, { name: "reason", label: "Reason", type: "text", maxlength: 160 }
  ], confirm: "Save" });
  if (!v) return;
  var body = { reason: v.reason || undefined };
  if (v.name !== g.name) body.name = v.name;
  if (v.description !== g.description) body.description = v.description;
  if (v.notice !== g.notice) body.notice = v.notice;
  await guildAction("update", body, "Guild updated.", false);
};
A.gDisband = async function () {
  var g = S.guild.guild;
  var v = await dialog({ title: "Disband " + g.name, text: "The guild is deleted and its " + g.memberCount + " member(s) are told they were removed. This cannot be undone.", fields: [{ name: "reason", label: "Reason", type: "text", maxlength: 160 }], confirm: "Disband", danger: true });
  if (v) await guildAction("disband", { reason: v.reason || undefined }, "Guild disbanded.", true);
};
A.gLeader = async function (el) {
  if (await confirmAction("Transfer leadership", "Make " + (el.getAttribute("data-name") || "this member") + " the leader. The current leader becomes an officer.", "Transfer", false)) {
    await guildAction("transfer", { memberId: el.getAttribute("data-id") }, "Leadership transferred.", false);
  }
};
A.gKick = async function (el) {
  if (await confirmAction("Kick member", "Remove " + (el.getAttribute("data-name") || "this member") + " from the guild.", "Kick")) {
    await guildAction("kick", { memberId: el.getAttribute("data-id") }, "Member removed.", false);
  }
};

// ── Chat moderation ─────────────────────────────────────────────────
S.chat = { scope: "global", channel: "", guildId: "", userId: "", messages: [], done: false, channels: null, guilds: null };
async function chatPrepare() {
  var st = S.chat;
  if (st.channels === null) {
    try { st.channels = (await api("/admin/runtime/chat/channels")).channels; } catch (e) { st.channels = []; }
  }
  if (st.guilds === null) {
    try { st.guilds = (await api("/admin/runtime/guilds" + qs({ sort: "name", dir: "asc", pageSize: 100 }))).rows; } catch (e) { st.guilds = []; }
  }
}
function chatFilters() {
  var st = S.chat;
  var scope = st.scope === "global"
    ? '<label class="field"><span>Channel</span><select data-change="chatFilter" data-key="channel"><option value="">All channels</option>' +
      (st.channels || []).map(function (c) { return '<option value="' + c.channel + '"' + (String(c.channel) === String(st.channel) ? " selected" : "") + ">Channel " + c.channel + " (" + c.messages + ")</option>"; }).join("") + "</select></label>"
    : '<label class="field"><span>Guild</span><select data-change="chatFilter" data-key="guildId"><option value="">All guilds</option>' +
      (st.guilds || []).map(function (g) { return '<option value="' + esc(g.guildId) + '"' + (g.guildId === st.guildId ? " selected" : "") + ">" + esc(g.name) + "</option>"; }).join("") + "</select></label>";
  return '<div class="filters">' + scope + '<label class="field"><span>Sender (nickname or id)</span><input type="text" data-change="chatFilter" data-key="userId" value="' + esc(st.userId) + '" placeholder="Optional" /></label></div>';
}
function renderChatTable() {
  var st = S.chat;
  if (!$("chTable")) return;
  if (!st.messages.length) { $("chTable").innerHTML = emptyHtml("No messages."); return; }
  var rows = st.messages.map(function (m) {
    var sender = m.system ? '<span class="muted">System</span>' : (m.userId ? playerLink(m.userId, m.nickname) : esc(m.nickname));
    var where = m.scope === "global" ? "Channel " + m.channel : esc(m.guildName || "");
    var actions = m.system ? "" : '<button class="btn text" data-act="chMute" data-id="' + esc(m.userId || "") + '">Mute</button>';
    return "<tr><td class=\"nowrap\">" + esc(fmtDate(m.createdAt)) + "</td><td>" + where + "</td><td>" + sender + '<div class="cell-sub">level ' + m.level + '</div></td><td style="overflow-wrap:anywhere;min-width:240px">' +
      (m.system ? '<span class="muted">' + esc(m.message) + "</span>" : esc(m.original || m.message)) +
      (m.original ? '<div class="cell-sub" title="' + esc(m.message) + '">masked for players: ' + esc(m.message) + "</div>" : "") + '</td><td class="num nowrap">' + actions +
      '<button class="btn text red" data-act="chDelete" data-id="' + m.id + '">Delete</button></td></tr>';
  }).join("");
  $("chTable").innerHTML = '<div class="table-wrap"><table><thead><tr><th>When</th><th>Where</th><th>Sender</th><th>Message</th><th></th></tr></thead><tbody>' + rows + "</tbody></table></div>" +
    (st.done ? "" : '<div class="pager"><span></span><button class="btn small" data-act="chMore">Load older</button></div>');
}
async function loadChat(more) {
  var st = S.chat;
  if (!$("chTable")) return;
  if (!more) $("chTable").innerHTML = loadingHtml("Loading messages...");
  try {
    var before = more && st.messages.length ? st.messages[st.messages.length - 1].id : null;
    var data = await api("/admin/runtime/chat/messages" + qs({ scope: st.scope, channel: st.scope === "global" ? st.channel : "", guildId: st.scope === "guild" ? st.guildId : "", userId: st.userId, limit: 50, before: before }));
    st.messages = more ? st.messages.concat(data.messages) : data.messages;
    st.done = data.messages.length < 50;
  } catch (error) {
    $("chTable").innerHTML = errorHtml(error.message, "chReload");
    return;
  }
  renderChatTable();
}
A.chReload = function () { return loadChat(false); };
A.chMore = function () { return loadChat(true); };
A.chatScope = function (el) { S.chat.scope = el.getAttribute("data-tab"); S.chat.channel = ""; S.chat.guildId = ""; VIEWS.chat(); };
// The sender box takes a nickname, username, email or id: anything that is not an id is looked up first.
A.chatFilter = async function (el) {
  var key = el.getAttribute("data-key");
  var value = el.value.trim();
  if (key === "userId" && value && !/^[0-9a-f-]{36}$/i.test(value)) {
    var found = await api("/admin/runtime/players/search" + qs({ q: value, limit: 1 }));
    if (!found.results.length) { toast("No player matches that search.", "warn"); return; }
    value = found.results[0].userId;
    el.value = value;
  }
  S.chat[key] = value;
  loadChat(false);
};
VIEWS.chat = async function () {
  var st = S.chat;
  content().innerHTML = pageHead("Chat", "Recent messages as stored. Deleting a line removes it from the history; clients that already received it keep it until they reconnect.") +
    '<div class="panel">' + tabsHtml([{ id: "global", label: "Global channels" }, { id: "guild", label: "Guild chat" }, { id: "filter", label: "Word filter" }], st.scope, "chatScope") + '<div id="chFilters"></div><div id="chTable">' + loadingHtml() + "</div></div>";
  if (st.scope === "filter") { loadChatFilter(); return; }
  await chatPrepare();
  if (!$("chFilters")) return;
  $("chFilters").innerHTML = chatFilters();
  loadChat(false);
};
A.chDelete = async function (el) {
  var id = Number(el.getAttribute("data-id"));
  var v = await dialog({ title: "Delete message", text: "The line is removed from the chat history.", fields: [{ name: "reason", label: "Reason", type: "text", maxlength: 160 }], confirm: "Delete", danger: true });
  if (!v) return;
  await post("/admin/runtime/chat/messages/delete", { scope: S.chat.scope, id: id, reason: v.reason || undefined });
  S.chat.messages = S.chat.messages.filter(function (m) { return m.id !== id; });
  toast("Message deleted.", "ok");
  renderChatTable();
};
A.chMute = async function (el) {
  var v = await dialog({ title: "Mute sender", text: "Blocks every chat channel (global and guild).", fields: [{ name: "duration", label: "Duration", type: "select", value: "3600", options: DURATIONS }, { name: "reason", label: "Reason", type: "text", maxlength: 255 }], confirm: "Mute", danger: true });
  if (!v) return;
  await post(playerPath(el.getAttribute("data-id"), "mute"), { until: untilIso(v.duration), reason: v.reason || undefined });
  toast("Player muted.", "warn");
};

// ── Mail ────────────────────────────────────────────────────────────
S.mail = { tab: "compose", history: null, direct: [], directDone: false };
async function loadMailHistory(more) {
  var st = S.mail;
  if (!$("mlBody")) return;
  if (!more) $("mlBody").innerHTML = loadingHtml("Loading mail history...");
  try {
    var before = more && st.direct.length ? st.direct[st.direct.length - 1].auditId : null;
    var data = await api("/admin/runtime/mail/history" + qs({ limit: 50, before: before }));
    st.history = data.broadcasts;
    st.direct = more ? st.direct.concat(data.direct) : data.direct;
    st.directDone = data.direct.length < 50;
  } catch (error) {
    $("mlBody").innerHTML = errorHtml(error.message, "mailHistoryReload");
    return;
  }
  renderMailHistory();
}
A.mailHistoryReload = function () { return loadMailHistory(false); };
A.mailMore = function () { return loadMailHistory(true); };
function renderMailHistory() {
  var st = S.mail;
  if (!$("mlBody")) return;
  if (st.tab === "broadcasts") {
    if (!st.history.length) { $("mlBody").innerHTML = emptyHtml("No broadcasts sent."); return; }
    var rows = st.history.map(function (b) {
      return "<tr><td><strong>" + esc(b.title) + '</strong><div class="cell-sub">' + esc(b.sender || "-") + "</div></td><td>" + (b.hasRewards ? "Yes" : "No") + "</td><td>" + (b.includeNewPlayers ? "Yes" : "No") +
        '</td><td class="num">' + fmtNum(b.recipients) + "</td><td>" + esc(fmtDate(b.createdAt)) + "</td><td>" + (b.expiresAt ? esc(fmtDate(b.expiresAt)) : "Never") + "</td><td>" +
        (b.active ? statusDot("ok", "Delivering") : statusDot("", "Expired")) + '</td><td class="num">' + (b.active ? '<button class="btn text red" data-act="mailRevoke" data-id="' + esc(b.id) + '">Revoke</button>' : "") + "</td></tr>";
    }).join("");
    $("mlBody").innerHTML = '<div class="table-wrap"><table><thead><tr><th>Mail</th><th>Rewards</th><th>New players too</th><th class="num">Delivered to</th><th>Sent</th><th>Expires</th><th>Status</th><th></th></tr></thead><tbody>' + rows + "</tbody></table></div>" +
      '<div class="pager"><span>Revoking stops delivery to inboxes that have not received the mail yet; copies already delivered stay.</span></div>';
    return;
  }
  if (!st.direct.length) { $("mlBody").innerHTML = emptyHtml("No single-player mails sent from the panel (within audit retention)."); return; }
  var drows = st.direct.map(function (m) {
    return '<tr><td class="nowrap">' + esc(fmtDate(m.createdAt)) + "</td><td>" + (m.userId ? playerLink(m.userId, m.username || shortId(m.userId)) : "-") + "</td><td><strong>" + esc(m.title) + "</strong></td><td>" + esc(m.reason || "-") + "</td></tr>";
  }).join("");
  $("mlBody").innerHTML = '<div class="table-wrap"><table><thead><tr><th>Sent</th><th>Player</th><th>Title</th><th>Reason</th></tr></thead><tbody>' + drows + "</tbody></table></div>" +
    (st.directDone ? "" : '<div class="pager"><span></span><button class="btn small" data-act="mailMore">Load older</button></div>');
}
A.mailTab = function (el) { S.mail.tab = el.getAttribute("data-tab"); VIEWS.mail(); };
A.mailRevoke = async function (el) {
  var v = await dialog({ title: "Revoke broadcast", text: "Players that have not received this mail yet will not receive it.", fields: [{ name: "reason", label: "Reason", type: "text", maxlength: 160 }], confirm: "Revoke", danger: true });
  if (!v) return;
  await post("/admin/runtime/mail/broadcasts/" + encodeURIComponent(el.getAttribute("data-id")) + "/revoke", { reason: v.reason || undefined });
  toast("Broadcast revoked.", "warn");
  loadMailHistory(false);
};
A.mailRecipients = function (el) {
  var all = el.value === "all";
  $("mlTargetBox").classList.toggle("hidden", all);
  $("mlIncludeBox").classList.toggle("hidden", !all);
};
A.mailSend = async function () {
  var all = $("mlRecipients").value === "all";
  var title = $("mlTitle").value.trim();
  if (!title) throw new Error("Mail title is required.");
  var body = {
    sender: $("mlSender").value.trim() || undefined, title: title, body: $("mlBody2").value || undefined,
    expirationDays: Math.max(0, Math.floor(num($("mlExpiry").value, 30))), attachments: parseAttachments($("mlCurrencies").value, $("mlJson").value)
  };
  if (all) {
    if (!(await confirmAction("Send to all players", "This mail is delivered to every player's inbox. Use Revoke in History to stop it.", "Send to everyone", false))) return;
    body.broadcast = true;
    body.includeNewPlayers = $("mlInclude").value === "true";
  } else {
    var target = lookupValue($("mlTarget"));
    if (!target) throw new Error("Choose the player to send the mail to.");
    body.target = target;
  }
  var data = await post("/admin/runtime/mail/send", body);
  toast(all ? "Broadcast stored: players receive it when they open the game." : "Mail sent to " + data.target.username + ".", "ok");
  $("mlTitle").value = "";
  $("mlBody2").value = "";
};
VIEWS.mail = function () {
  var st = S.mail;
  var tabs = tabsHtml([{ id: "compose", label: "Compose" }, { id: "broadcasts", label: "Broadcasts" }, { id: "direct", label: "Single player" }], st.tab, "mailTab");
  var compose = '<div class="panel-body form" style="max-width:760px">' +
    '<div class="row"><label class="field"><span>Recipients</span><select id="mlRecipients" data-change="mailRecipients"><option value="one">One player</option><option value="all">All players (broadcast)</option></select></label>' +
    '<div class="field" id="mlTargetBox">' + lookupHtml("mlTarget", "Player", "Nickname, username, email or id") + "</div>" +
    '<label class="field hidden" id="mlIncludeBox"><span>Accounts created later</span><select id="mlInclude"><option value="false">Do not receive it</option><option value="true">Receive it until it expires</option></select></label></div>' +
    '<div class="row"><label class="field"><span>Sender</span><input id="mlSender" type="text" maxlength="32" value="Game Master" /></label>' +
    '<label class="field"><span>Expires in days (0 = never)</span><input id="mlExpiry" type="number" min="0" max="3650" value="30" /></label></div>' +
    '<label class="field"><span>Title</span><input id="mlTitle" type="text" maxlength="80" placeholder="Maintenance compensation" /></label>' +
    '<label class="field"><span>Message</span><textarea id="mlBody2" maxlength="1000"></textarea></label>' +
    '<label class="field"><span>Currencies (id:amount, comma separated)</span><input id="mlCurrencies" type="text" maxlength="400" placeholder="DM:100, GO:20000" /></label>' +
    '<label class="field"><span>Advanced rewards JSON (shop payload; replaces the currencies)</span><textarea id="mlJson" placeholder="{&quot;runes&quot;:[{&quot;tier&quot;:6,&quot;quantity&quot;:1}]}"></textarea></label>' +
    '<div><button class="btn primary" data-act="mailSend">Send mail</button></div></div>';
  content().innerHTML = pageHead("Mail", "Mailbox messages with optional rewards, granted when the player claims them.", '<button class="btn primary" data-act="mailTab" data-tab="compose">New mail</button>') +
    '<div class="panel">' + tabs + (st.tab === "compose" ? compose : '<div id="mlBody">' + loadingHtml() + "</div>") + "</div>";
  if (st.tab !== "compose") loadMailHistory(false);
};

// ── Audit log ───────────────────────────────────────────────────────
S.audit = { entries: [], done: false, kinds: null, kind: "", userId: "", from: "", to: "" };
function renderAuditTable() {
  var st = S.audit;
  if (!$("auTable")) return;
  if (!st.entries.length) { $("auTable").innerHTML = emptyHtml("No audit entries match."); return; }
  var rows = st.entries.map(function (e) {
    var meta = e.meta === null || e.meta === undefined ? "" : JSON.stringify(e.meta);
    return '<tr><td class="mono">' + e.id + '</td><td class="nowrap">' + esc(fmtDate(e.createdAt)) + "</td><td><strong>" + esc(e.kind) + "</strong></td><td>" +
      (e.userId ? playerLink(e.userId, e.username || shortId(e.userId)) : '<span class="muted">-</span>') + '</td><td class="cell-sub" style="max-width:520px;overflow-wrap:anywhere">' + esc(meta.length > 260 ? meta.slice(0, 260) + "..." : meta) + "</td></tr>";
  }).join("");
  $("auTable").innerHTML = '<div class="table-wrap"><table><thead><tr><th>Id</th><th>When</th><th>Kind</th><th>Player</th><th>Details</th></tr></thead><tbody>' + rows + "</tbody></table></div>" +
    (st.done ? "" : '<div class="pager"><span></span><button class="btn small" data-act="auMore">Load older</button></div>');
}
async function loadAuditLog(more) {
  var st = S.audit;
  if (!$("auTable")) return;
  if (!more) $("auTable").innerHTML = loadingHtml("Loading audit log...");
  try {
    var before = more && st.entries.length ? st.entries[st.entries.length - 1].id : null;
    var from = st.from ? new Date(st.from + "T00:00:00").toISOString() : "";
    var to = st.to ? new Date(st.to + "T23:59:59").toISOString() : "";
    var data = await api("/admin/runtime/audit" + qs({ kind: st.kind, userId: st.userId, from: from, to: to, before: before, limit: 50 }));
    st.entries = more ? st.entries.concat(data.entries) : data.entries;
    st.done = data.entries.length < 50;
  } catch (error) {
    $("auTable").innerHTML = errorHtml(error.message, "auSearch");
    return;
  }
  renderAuditTable();
}
A.auMore = function () { return loadAuditLog(true); };
A.auSearch = async function () {
  var st = S.audit;
  st.kind = $("auKind").value;
  st.from = $("auFrom").value;
  st.to = $("auTo").value;
  var who = lookupValue($("auPlayer"));
  if (who && !$("auPlayer").dataset.userId && !/^[0-9a-f-]{36}$/i.test(who)) {
    var found = await api("/admin/runtime/players/search" + qs({ q: who, limit: 1 }));
    if (!found.results.length) { toast("No player matches that search.", "warn"); return; }
    who = found.results[0].userId;
  }
  st.userId = who;
  loadAuditLog(false);
};
VIEWS.audit = async function () {
  var st = S.audit;
  content().innerHTML = pageHead("Audit log", "Everything recorded by the server: player actions, rewards, GM actions and logins.") +
    '<div class="panel"><div class="filters"><label class="field"><span>Kind</span><select id="auKind"><option value="">All kinds</option></select></label>' +
    '<div class="field" style="flex-basis:240px">' + lookupHtml("auPlayer", "Player", "Nickname, username, email or id") + "</div>" +
    '<label class="field"><span>From</span><input id="auFrom" type="date" value="' + esc(st.from) + '" /></label><label class="field"><span>To</span><input id="auTo" type="date" value="' + esc(st.to) + '" /></label>' +
    '<button class="btn primary" data-act="auSearch">Search</button></div><div id="auTable">' + loadingHtml() + "</div></div>";
  if (st.kinds === null) {
    try { st.kinds = (await api("/admin/runtime/audit/kinds")).kinds; } catch (e) { st.kinds = []; }
  }
  if (!$("auKind")) return;
  $("auKind").innerHTML = '<option value="">All kinds</option>' + st.kinds.map(function (k) { return '<option value="' + esc(k) + '"' + (k === st.kind ? " selected" : "") + ">" + esc(k) + "</option>"; }).join("");
  loadAuditLog(false);
};

// ── Config (read only) ──────────────────────────────────────────────
VIEWS.config = async function () {
  content().innerHTML = pageHead("Config", "Catalogs loaded from game_config. Import a new Unity export with POST /admin/config/import.", '<button class="btn" data-act="reload">Refresh</button>') +
    '<div class="panel" id="cfBody">' + loadingHtml() + "</div>";
  try {
    var data = await api("/admin/runtime/config/files");
    if (!$("cfBody")) return;
    if (!data.files.length) { $("cfBody").innerHTML = emptyHtml("No catalog files found."); return; }
    var rows = data.files.map(function (f) {
      var counts = Object.keys(f.counts).map(function (k) { return esc(k) + " " + fmtNum(f.counts[k]); }).join(", ");
      return "<tr><td><strong>" + esc(f.file) + "</strong></td><td>" + esc(f.version || "-") + "</td><td>" + esc(fmtDate(f.updatedAt)) +
        '</td><td class="num">' + esc(fmtBytes(f.bytes)) + '</td><td class="cell-sub" style="max-width:420px">' + (counts || "-") + "</td></tr>";
    }).join("");
    $("cfBody").innerHTML = '<div class="table-wrap"><table><thead><tr><th>File</th><th>Version</th><th>Updated</th><th class="num">Size</th><th>Entries</th></tr></thead><tbody>' + rows + "</tbody></table></div>";
  } catch (error) {
    if ($("cfBody")) $("cfBody").innerHTML = errorHtml(error.message, "reload");
  }
};

// ── Grants ──────────────────────────────────────────────────────────
VIEWS.grants = async function () {
  await loadCatalog();
  content().innerHTML = pageHead("Grants", "Give currencies, monsters or runes to one player. The player is notified live and every grant is audited.") +
    '<div class="panel"><div class="panel-body form" style="max-width:640px">' + lookupHtml("grTarget", "Player", "Nickname, username, email or id") +
    '<div class="row"><button class="btn primary" data-act="grCurrency">Grant currency</button><button class="btn primary" data-act="grCharacter">Grant monster</button><button class="btn primary" data-act="grRune">Grant rune</button></div></div></div>';
};
function grantTarget() {
  var target = lookupValue($("grTarget"));
  if (!target) throw new Error("Choose the player first.");
  return target;
}
A.grCurrency = function () { return grantCurrencyDialog(grantTarget()); };
A.grCharacter = function () { return grantCharacterDialog(grantTarget()); };
A.grRune = function () { return grantRuneDialog(grantTarget()); };
`;
