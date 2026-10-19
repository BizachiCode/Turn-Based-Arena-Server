// GM panel client, part 5: Reports (queue + detail with resolve / dismiss / bulk decisions), the "Reports" tab of the
// player page and the chat "Word filter" panel (stats + test box).
export const SCRIPT_REPORTS = String.raw`
S.reports = { filter: "open", q: "", sort: "created", dir: "desc", page: 1, pageSize: 25, data: null };
S.report = null;

var REPORT_CATEGORIES = { spam: "Spam", offensive: "Offensive behavior", cheating: "Cheating", name: "Inappropriate name", other: "Other" };
var REPORT_SOURCES = { global_chat: "Global chat", guild_chat: "Guild chat", private_chat: "Private chat", profile: "Profile", arena: "Arena", friends: "Friends", other: "Other" };
var REPORT_ACTIONS = [["none", "Acknowledge only (no sanction)"], ["warn", "Warn by mail"], ["mute", "Mute in chat"], ["kick", "Kick"], ["ban", "Ban"]];
var REPORT_MUTE_HOURS = [["1", "1 hour"], ["6", "6 hours"], ["24", "1 day"], ["72", "3 days"], ["168", "7 days"], ["720", "30 days"]];
var REPORT_BAN_DAYS = [["1", "1 day"], ["3", "3 days"], ["7", "7 days"], ["30", "30 days"], ["90", "90 days"], ["0", "Permanent"]];
var REPORTS_PATH = "/admin/runtime/reports";

function categoryText(value) { return REPORT_CATEGORIES[value] || String(value); }
function sourceText(value) { return REPORT_SOURCES[value] || String(value); }
function reportStatusDot(status) {
  return statusDot(status === "open" ? "warn" : status === "resolved" ? "ok" : "", String(status).charAt(0).toUpperCase() + String(status).slice(1));
}
function actionText(value) {
  var hit = REPORT_ACTIONS.filter(function (a) { return a[0] === value; })[0];
  return hit ? hit[1] : (value || "-");
}
function clip(text, max) {
  var value = String(text === null || text === undefined ? "" : text);
  return value.length > max ? value.slice(0, max) + "..." : value;
}
function reportPlayer(entry) {
  if (!entry || !entry.userId) return '<span class="muted">Deleted account</span>';
  return playerLink(entry.userId, entry.name || entry.username || shortId(entry.userId));
}

// ── Queue ───────────────────────────────────────────────────────────
function reportRowsTable(rows, withPlayers) {
  return rows.map(function (row) {
    var target = row.target;
    var reporter = row.reporter;
    var openNote = row.status === "open" && row.openAgainstTarget > 1 ? '<div class="cell-sub">' + fmtNum(row.openAgainstTarget) + " open reports</div>" : "";
    return '<tr class="clickable" data-act="go" data-to="#reports/' + row.id + '"><td><a>' + esc(target.name || target.username || shortId(target.userId)) + "</a>" + openNote + "</td>" +
      "<td>" + esc(categoryText(row.category)) + "</td>" +
      "<td>" + esc(reporter.userId ? (reporter.name || reporter.username || shortId(reporter.userId)) : "Deleted account") + "</td>" +
      "<td>" + esc(sourceText(row.source)) + "</td>" +
      '<td style="max-width:320px;overflow-wrap:anywhere">' + esc(clip(row.comment, 90)) + "</td>" +
      '<td class="nowrap">' + esc(fmtAgo(row.createdAt)) + "</td><td>" + reportStatusDot(row.status) + (withPlayers && row.resolutionAction && row.resolutionAction !== "none" ? '<div class="cell-sub">' + esc(actionText(row.resolutionAction)) + "</div>" : "") + "</td></tr>";
  }).join("");
}
function renderReportsTable() {
  var st = S.reports, data = st.data;
  if (!data || !$("rpTable")) return;
  $("rpTabs").innerHTML = tabsHtml([
    { id: "open", label: "Open", count: data.counts.open }, { id: "resolved", label: "Resolved", count: data.counts.resolved },
    { id: "dismissed", label: "Dismissed", count: data.counts.dismissed }, { id: "all", label: "All", count: data.counts.all }
  ], st.filter, "filterTab", ' data-scope="reports"');
  if (!data.rows.length) { $("rpTable").innerHTML = emptyHtml(st.q ? "No reports match your search." : st.filter === "open" ? "No open reports. Nice and quiet." : "No reports in this tab."); return; }
  var head = sortTh("Reported player", "target", st, "reports") + sortTh("Category", "category", st, "reports") + sortTh("Reporter", "reporter", st, "reports") +
    "<th>Source</th><th>Comment</th>" + sortTh("Filed", "created", st, "reports") + sortTh("Status", "status", st, "reports");
  $("rpTable").innerHTML = '<div class="table-wrap"><table><thead><tr>' + head + "</tr></thead><tbody>" + reportRowsTable(data.rows, true) + "</tbody></table></div>" + pagerHtml(st, data.total, "reports");
}
LOADERS.reports = async function () {
  var st = S.reports;
  if (!$("rpTable")) return;
  $("rpTable").innerHTML = loadingHtml("Loading reports...");
  try {
    st.data = await api(REPORTS_PATH + qs({ tab: st.filter, q: st.q, sort: st.sort, dir: st.dir, page: st.page, pageSize: st.pageSize }));
  } catch (error) {
    $("rpTable").innerHTML = errorHtml(error.message, "reload");
    return;
  }
  setReportsBadge(st.data.counts.open);
  renderReportsTable();
};

VIEWS.reports = async function (r) {
  if (r.id) { await renderReportDetail(r.id); return; }
  content().innerHTML = pageHead("Reports", "Player reports with the chat evidence the server copied when they were filed.") +
    '<div class="panel"><div id="rpTabs"></div>' + searchRow("reports", "Search by reporter or reported player", S.reports.q) + '<div id="rpTable"></div></div>';
  LOADERS.reports();
};

// ── Detail ──────────────────────────────────────────────────────────
async function renderReportDetail(id) {
  content().innerHTML = loadingHtml("Loading report...");
  try {
    S.report = (await api(REPORTS_PATH + "/" + encodeURIComponent(id))).detail;
  } catch (error) {
    S.report = null;
    content().innerHTML = pageHead("Report", "", "", '<div class="crumb"><a data-act="go" data-to="#reports">Reports</a></div>') + '<div class="panel">' + errorHtml(error.message, "reload") + "</div>";
    return;
  }
  drawReportDetail();
}
function relatedRows(list) {
  return list.map(function (row) {
    return '<tr class="clickable" data-act="go" data-to="#reports/' + row.id + '"><td class="mono">#' + row.id + "</td><td>" + esc(categoryText(row.category)) + "</td><td>" +
      esc(row.reporter.userId ? (row.reporter.name || row.reporter.username || shortId(row.reporter.userId)) : "Deleted account") + "</td><td>" + esc(fmtAgo(row.createdAt)) + "</td><td>" + reportStatusDot(row.status) + "</td></tr>";
  }).join("");
}
function drawReportDetail() {
  var d = S.report, rp = d.report, t = d.target, open = rp.status === "open";
  var id = rp.id;
  var actions = open
    ? '<button class="btn primary" data-act="rpResolve">Resolve</button><button class="btn" data-act="rpDismiss">Dismiss</button>' +
      (rp.openAgainstTarget > 1
        ? '<button class="btn text red" data-act="rpResolveAll">Resolve all ' + fmtNum(rp.openAgainstTarget) + ' against player</button><button class="btn text" data-act="rpDismissAll">Dismiss all</button>'
        : "")
    : "";
  var sub = reportStatusDot(rp.status) + ' &nbsp; <span class="muted">' + esc(categoryText(rp.category)) + " - filed " + esc(fmtDate(rp.createdAt)) + "</span>";
  var banner = "";
  if (!open) {
    banner = '<div class="banner ' + (rp.status === "resolved" ? "ok" : "") + '" style="margin-bottom:16px"><strong>' + (rp.status === "resolved" ? "Resolved" : "Dismissed") + "</strong> " + esc(fmtDate(rp.handledAt)) +
      (rp.resolutionAction && rp.resolutionAction !== "none" ? " - " + esc(actionText(rp.resolutionAction)) : "") + (rp.resolutionNote ? " - " + esc(rp.resolutionNote) : "") + "</div>";
  }
  var evidence = rp.messageText
    ? '<blockquote class="quote">' + esc(rp.messageText) + '</blockquote><div class="cell-sub" style="margin-top:6px">Line #' + esc(rp.messageId) + " - " +
      (rp.source === "guild_chat" ? "guild chat" : "channel " + esc(rp.sourceRef)) + " - copied by the server</div>"
    : '<span class="muted">No chat line attached (' + esc(sourceText(rp.source)) + ").</span>";
  var context = rp.context.length
    ? '<div class="table-wrap"><table><thead><tr><th>When</th><th>Where</th><th>Line</th></tr></thead><tbody>' + rp.context.map(function (l) {
      return '<tr><td class="nowrap">' + esc(fmtDate(l.at)) + "</td><td>" + (l.source === "guild" ? "Guild chat" : "Channel " + esc(l.ref)) + '</td><td style="overflow-wrap:anywhere">' + esc(l.text) + "</td></tr>";
    }).join("") + "</tbody></table></div>"
    : '<div class="state">No stored chat lines for this player.</div>';
  var statuses = [];
  if (t.banned) statuses.push(statusDot("bad", "Banned"));
  if (t.muted) statuses.push(statusDot("warn", "Muted"));
  var reporterCell = rp.reporter.userId ? playerLink(rp.reporter.userId, rp.reporter.name || rp.reporter.username || shortId(rp.reporter.userId)) : '<span class="muted">Deleted account</span>';
  var related = d.related.length
    ? '<div class="table-wrap"><table><thead><tr><th>Report</th><th>Category</th><th>Reporter</th><th>Filed</th><th>Status</th></tr></thead><tbody>' + relatedRows(d.related) + "</tbody></table></div>"
    : '<div class="state">No other reports against this player.</div>';
  var sanctions = d.sanctions.length
    ? '<div class="table-wrap"><table><thead><tr><th>When</th><th>Kind</th><th>Details</th></tr></thead><tbody>' + d.sanctions.map(function (s) {
      var meta = s.meta === null || s.meta === undefined ? "" : JSON.stringify(s.meta);
      return '<tr><td class="nowrap">' + esc(fmtDate(s.createdAt)) + "</td><td><strong>" + esc(s.kind) + '</strong></td><td class="cell-sub" style="overflow-wrap:anywhere">' + esc(clip(meta, 200)) + "</td></tr>";
    }).join("") + "</tbody></table></div>"
    : '<div class="state">No moderation history.</div>';

  content().innerHTML = pageHead("Report #" + id, sub, actions, '<div class="crumb"><a data-act="go" data-to="#reports">Reports</a></div>') + banner +
    '<div class="grid2"><div class="stack">' +
    '<div class="panel"><div class="panel-head"><h2>Report</h2></div><div class="panel-body">' + kv([
      ["Category", categoryText(rp.category)], ["Source", sourceText(rp.source)], ["Comment", rp.comment || "-"], ["Filed", fmtDate(rp.createdAt)]
    ]) + "</div></div>" +
    '<div class="panel"><div class="panel-head"><h2>Reported message</h2></div><div class="panel-body">' + evidence + "</div></div>" +
    '<div class="panel"><div class="panel-head"><h2>Recent lines of the player</h2></div>' + context + "</div>" +
    '</div><div class="stack">' +
    '<div class="panel"><div class="panel-head"><h2>Reported player</h2><button class="btn small" data-act="go" data-to="#players/' + encodeURIComponent(t.userId) + '">Open player</button></div><div class="panel-body">' + kv([
      ["Player", playerLink(t.userId, t.name || t.username || shortId(t.userId)), true], ["Account", t.username], ["Level", t.level === null ? "-" : fmtNum(t.level)],
      ["Status", statuses.length ? statuses.join(" &nbsp; ") : "In good standing", true], ["Open reports", fmtNum(rp.openAgainstTarget)]
    ]) + "</div></div>" +
    '<div class="panel"><div class="panel-head"><h2>Reporter</h2></div><div class="panel-body">' + kv([["Player", reporterCell, true]]) + "</div></div>" +
    '<div class="panel"><div class="panel-head"><h2>Other reports against this player</h2></div>' + related + "</div>" +
    '<div class="panel"><div class="panel-head"><h2>Moderation history</h2></div>' + sanctions + "</div>" +
    "</div></div>";
}

function reportResolveFields() {
  return [
    { name: "action", label: "Action", type: "select", value: "none", options: REPORT_ACTIONS },
    { name: "muteHours", label: "Mute duration (Mute action)", type: "select", value: "24", options: REPORT_MUTE_HOURS },
    { name: "banDays", label: "Ban duration (Ban action)", type: "select", value: "7", options: REPORT_BAN_DAYS },
    { name: "message", label: "Message to the player (warning mail, kick or ban reason)", type: "textarea", maxlength: 255, placeholder: "Optional" },
    { name: "note", label: "Internal note", type: "text", maxlength: 255, placeholder: "Kept on the report and in the audit trail" }
  ];
}
function reportResolveBody(v) {
  var body = { action: v.action, note: v.note || undefined, message: v.message || undefined };
  if (v.action === "mute") body.muteHours = Number(v.muteHours);
  if (v.action === "ban") body.banDays = Number(v.banDays) > 0 ? Number(v.banDays) : null;
  return body;
}
async function reportDecided(message, tone) {
  toast(message, tone || "ok");
  refreshStatus();
  if (S.report) await renderReportDetail(S.report.report.id);
}
A.rpResolve = async function () {
  var id = S.report.report.id;
  var v = await dialog({ title: "Resolve report #" + id, wide: true, text: "Applies the action to the reported player and closes this report. The reporter is thanked by mail when an action is taken.", fields: reportResolveFields(), confirm: "Resolve", danger: true });
  if (!v) return;
  var data = await post(REPORTS_PATH + "/" + id + "/resolve", reportResolveBody(v));
  await reportDecided(data.action === "none" ? "Report resolved." : "Report resolved: " + actionText(data.action) + ".", data.action === "none" ? "ok" : "warn");
};
A.rpDismiss = async function () {
  var id = S.report.report.id;
  var v = await dialog({ title: "Dismiss report #" + id, text: "Closes the report without any action.", fields: [{ name: "note", label: "Internal note", type: "text", maxlength: 255, placeholder: "Optional" }], confirm: "Dismiss", danger: true });
  if (!v) return;
  await post(REPORTS_PATH + "/" + id + "/dismiss", { note: v.note || undefined });
  await reportDecided("Report dismissed.");
};
A.rpResolveAll = async function () {
  var rp = S.report.report;
  var v = await dialog({ title: "Resolve all reports against this player", wide: true, text: "The action is applied once and all " + rp.openAgainstTarget + " open reports against the player are closed.", fields: reportResolveFields(), confirm: "Resolve all", danger: true });
  if (!v) return;
  var data = await post(REPORTS_PATH + "/target/" + encodeURIComponent(rp.target.userId) + "/resolve", reportResolveBody(v));
  await reportDecided(fmtNum(data.reportIds.length) + " reports resolved.", data.action === "none" ? "ok" : "warn");
};
A.rpDismissAll = async function () {
  var rp = S.report.report;
  var v = await dialog({ title: "Dismiss all reports against this player", text: "Closes all " + rp.openAgainstTarget + " open reports without any action.", fields: [{ name: "note", label: "Internal note", type: "text", maxlength: 255, placeholder: "Optional" }], confirm: "Dismiss all", danger: true });
  if (!v) return;
  var data = await post(REPORTS_PATH + "/target/" + encodeURIComponent(rp.target.userId) + "/dismiss", { note: v.note || undefined });
  await reportDecided(fmtNum(data.reportIds.length) + " reports dismissed.");
};

// ── Player page tab ─────────────────────────────────────────────────
function playerReportTable(title, rows, emptyText) {
  return '<div class="panel" style="border:0;border-top:1px solid var(--line);border-radius:0"><div class="panel-head" style="border:0"><h2>' + esc(title) + "</h2></div>" +
    (rows.length
      ? '<div class="table-wrap"><table><thead><tr><th>Report</th><th>Category</th><th>Reporter</th><th>Reported player</th><th>Filed</th><th>Status</th></tr></thead><tbody>' + rows.map(function (row) {
        var reporter = row.reporter.userId ? (row.reporter.name || row.reporter.username || shortId(row.reporter.userId)) : "Deleted account";
        return '<tr class="clickable" data-act="go" data-to="#reports/' + row.id + '"><td class="mono">#' + row.id + "</td><td>" + esc(categoryText(row.category)) + "</td><td>" + esc(reporter) +
          "</td><td>" + esc(row.target.name || row.target.username || shortId(row.target.userId)) + "</td><td>" + esc(fmtAgo(row.createdAt)) + "</td><td>" + reportStatusDot(row.status) + "</td></tr>";
      }).join("") + "</tbody></table></div>"
      : emptyHtml(emptyText)) + "</div>";
}
function playerReportsHtml(rep) {
  return playerReportTable("Reports received (" + fmtNum(rep.received.length) + ")", rep.received, "Nobody reported this player.") +
    playerReportTable("Reports sent (" + fmtNum(rep.sent.length) + ")", rep.sent, "This player never reported anyone.");
}
function tabReports() {
  var rep = S.player.reports;
  return '<div id="pReports">' + (rep ? playerReportsHtml(rep) : loadingHtml("Loading reports...")) + "</div>";
}
async function loadPlayerReports() {
  var id = S.player.id;
  try {
    var received = await api(REPORTS_PATH + qs({ tab: "all", target: id, pageSize: 50 }));
    var sent = await api(REPORTS_PATH + qs({ tab: "all", reporter: id, pageSize: 50 }));
    if (!S.player || S.player.id !== id) return;
    S.player.reports = { received: received.rows, sent: sent.rows };
    if ($("pReports")) $("pReports").innerHTML = playerReportsHtml(S.player.reports);
  } catch (error) {
    if ($("pReports")) $("pReports").innerHTML = errorHtml(error.message);
  }
}

// ── Chat word filter ────────────────────────────────────────────────
async function loadChatFilter() {
  if (!$("chTable")) return;
  var data;
  try {
    data = await api("/admin/runtime/chat/filter");
  } catch (error) {
    $("chTable").innerHTML = errorHtml(error.message, "chFilterReload");
    return;
  }
  var f = data.filter, s = data.stats;
  var state = f.enabled ? statusDot("ok", "Enabled") : statusDot("", "Disabled");
  var rows = s.players.map(function (p) {
    return "<tr><td>" + playerLink(p.userId, p.username || shortId(p.userId)) + '</td><td class="num">' + fmtNum(p.masked) + '</td><td class="num">' + fmtNum(p.blocked) +
      "</td><td>" + esc(fmtAgo(new Date(p.lastAtUnix * 1000).toISOString())) + "</td></tr>";
  }).join("");
  $("chTable").innerHTML =
    '<div class="panel-body">' + kv([
      ["Status", state, true], ["Mode", f.mode === "block" ? "Block (the message is refused)" : "Mask (matches replaced by " + f.maskChar + ")"],
      ["Matching", f.wholeWordOnly ? "Whole words only" : "Inside words too"], ["Words", fmtNum(f.words)], ["Allow list", fmtNum(f.allowList)],
      ["Since", fmtDate(new Date(s.sinceUnix * 1000).toISOString()) + " (server start)"], ["Masked", fmtNum(s.masked)], ["Blocked", fmtNum(s.blocked)]
    ]) + "</div>" +
    '<div class="testbox"><label class="field"><span>Test filter</span><input type="text" id="fiTestInput" maxlength="300" placeholder="Type a message to see what the chat would do" autocomplete="off" /></label>' +
    '<button class="btn primary" data-act="fiTest">Test</button></div><div class="testout" id="fiTestOut"><span class="muted">The text is filtered with the live word list; nothing is counted or sent.</span></div>' +
    '<div class="panel-head"><h2>Players filtered since the server started</h2></div>' +
    (rows ? '<div class="table-wrap"><table><thead><tr><th>Player</th><th class="num">Masked</th><th class="num">Blocked</th><th>Last</th></tr></thead><tbody>' + rows + "</tbody></table></div>" : emptyHtml("Nothing was masked or blocked yet."));
}
A.chFilterReload = function () { return loadChatFilter(); };
A.fiTest = async function () {
  var input = $("fiTestInput");
  var text = input ? String(input.value || "").trim() : "";
  if (!text) { toast("Type a message to test.", "warn"); return; }
  var data = await api("/admin/runtime/chat/filter/test" + qs({ text: text }));
  var r = data.result;
  var verdict = !r.enabled ? statusDot("", "Filter disabled - the message goes through")
    : r.blocked ? statusDot("bad", "Blocked - the player would get MESSAGE_BLOCKED")
    : r.matched ? statusDot("warn", "Masked - the chat would show the text below")
    : statusDot("ok", "Clean - no banned word found");
  if ($("fiTestOut")) $("fiTestOut").innerHTML = verdict + (r.enabled && !r.blocked ? '<div style="margin-top:8px"><strong>' + esc(r.output) + "</strong></div>" : "");
};
`;
