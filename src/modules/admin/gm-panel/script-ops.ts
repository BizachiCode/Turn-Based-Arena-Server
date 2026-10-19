// GM panel client, part 2: Overview (analytics), Rooms & activity and Runtime controls.
export const SCRIPT_OPS = String.raw`
// ── Overview ────────────────────────────────────────────────────────
S.overview = { days: 7, a: "newAccounts", b: "activePlayers", data: null };
var METRIC_LABELS = {
  newAccounts: "New accounts", activePlayers: "Active players", logins: "Logins", battles: "Battles",
  mailDelivered: "Mail delivered", shopPurchases: "Shop purchases", shopSpent: "Shop spend", gmCurrencyGranted: "GM currency granted"
};
var METRIC_ORDER = ["newAccounts", "activePlayers", "logins", "battles", "mailDelivered", "shopPurchases", "shopSpent", "gmCurrencyGranted"];
var SERIES_COLORS = ["#4338b0", "#d99a0e"];

function metricName(key, data) {
  var label = METRIC_LABELS[key] || key;
  return key === "shopSpent" && data && data.shopSpentCurrency ? label + " (" + data.shopSpentCurrency + ")" : label;
}
function deltaHtml(total) {
  if (!total) return "";
  var d = total.delta;
  if (d === 0) return '<span class="delta flat">No change</span>';
  return '<span class="delta ' + (d > 0 ? "up" : "down") + '">' + (d > 0 ? "+" : "-") + fmtNum(Math.abs(d)) + "</span>";
}
function metricPill(slot, selected, data) {
  var options = (slot === "b" ? '<option value="">None</option>' : "") + METRIC_ORDER.map(function (key) {
    return '<option value="' + key + '"' + (key === selected ? " selected" : "") + ">" + esc(metricName(key, data)) + "</option>";
  }).join("");
  return '<div class="pill"><i style="background:' + SERIES_COLORS[slot === "a" ? 0 : 1] + '"></i><select data-change="ovMetric" data-slot="' + slot + '">' + options + "</select>" + icon("caret", 16) + "</div>";
}
function renderLive(snap) {
  var el = $("ovLive");
  if (!el) return;
  if (!snap) { el.innerHTML = ""; return; }
  var m = snap.maintenance || {};
  el.innerHTML = '<div class="panel metrics" style="margin-bottom:16px">' +
    '<div class="metric"><span>Online connections</span><strong>' + fmtNum(snap.totals.clients) + "</strong></div>" +
    '<div class="metric"><span>Rooms</span><strong>' + fmtNum(snap.totals.rooms) + "</strong></div>" +
    '<div class="metric"><span>Maintenance</span><strong>' + (m.enabled ? "On" : "Off") + "</strong></div>" +
    '<div class="metric"><span>Uptime</span><strong>' + fmtDuration(snap.uptimeSec) + "</strong></div>" +
    '<div class="metric"><span>Process memory</span><strong>' + fmtNum(Math.round(snap.host.rssMb)) + " MB</strong></div></div>";
}
async function loadOverview() {
  var st = S.overview;
  var chart = $("ovChart"), table = $("ovTable");
  if (!chart) return;
  chart.innerHTML = loadingHtml("Loading analytics...");
  table.innerHTML = "";
  try {
    st.data = (await api("/admin/runtime/analytics" + qs({ days: st.days }))).analytics;
  } catch (error) {
    chart.innerHTML = errorHtml(error.message, "reload");
    return;
  }
  renderOverview();
}
function renderOverview() {
  var st = S.overview, data = st.data;
  if (!data || !$("ovChart")) return;
  var labels = data.dates.map(function (d) { return d.slice(8, 10) + " " + MONTHS[Number(d.slice(5, 7)) - 1]; });
  var tips = data.dates.map(function (d) { return fmtDay(d + "T12:00:00"); });
  var model = { labels: labels, tips: tips, a: { name: metricName(st.a, data), color: SERIES_COLORS[0], values: data.series[st.a], area: true }, b: null };
  if (st.b) model.b = { name: metricName(st.b, data), color: SERIES_COLORS[1], values: data.series[st.b] };
  $("ovChart").innerHTML = '<div class="chart-head">' + metricPill("a", st.a, data) + metricPill("b", st.b, data) + "</div>" + '<div class="chart" id="ovChartBox"></div>';
  drawChart($("ovChartBox"), model);

  var cols = ["newAccounts", "activePlayers", "logins", "battles", "mailDelivered", "shopPurchases", "shopSpent", "gmCurrencyGranted"];
  var head = '<th>Day</th>' + cols.map(function (k) { return '<th class="num">' + esc(metricName(k, data)) + "</th>"; }).join("");
  var totals = '<tr class="totals"><td>Total<div class="cell-sub" style="font-weight:400;font-size:12px">' + fmtNum(data.totalAccounts) + " accounts overall</div></td>" + cols.map(function (k) {
    return '<td class="num">' + fmtNum(data.totals[k].value) + deltaHtml(data.totals[k]) + "</td>";
  }).join("") + "</tr>";
  var rows = "";
  for (var i = data.dates.length - 1; i >= 0; i--) {
    rows += "<tr><td>" + esc(fmtDay(data.dates[i] + "T12:00:00")) + "</td>" + cols.map(function (k) { return '<td class="num">' + fmtNum(data.series[k][i]) + "</td>"; }).join("") + "</tr>";
  }
  $("ovTable").innerHTML = '<div class="table-wrap"><table><thead><tr>' + head + "</tr></thead><tbody>" + totals + rows + "</tbody></table></div>" +
    '<div class="pager"><span>Totals compare with the previous ' + data.days + " days. Active players is the number of distinct players in the period. Days follow the database clock.</span></div>";
}
A.ovDays = function (el) { S.overview.days = Number(el.value); loadOverview(); };
A.ovMetric = function (el) {
  var st = S.overview;
  st[el.getAttribute("data-slot")] = el.value;
  if (st.a === st.b) st.b = "";
  renderOverview();
};
VIEWS.overview = function () {
  var st = S.overview;
  var period = '<div class="pill"><select data-change="ovDays">' + [7, 14, 30].map(function (d) {
    return '<option value="' + d + '"' + (d === st.days ? " selected" : "") + ">Last " + d + " days</option>";
  }).join("") + "</select>" + icon("caret", 16) + "</div>";
  content().innerHTML = pageHead("Overview", "Daily activity from game data, plus the live server state.", period) +
    '<div id="ovLive"></div><div class="panel" id="ovChart"></div><div class="panel" id="ovTable"></div>';
  S.onSnapshot = renderLive;
  renderLive(S.snapshot);
  S.timer = window.setInterval(refreshStatus, 15000);
  refreshStatus();
  loadOverview();
};

// ── Rooms & activity ────────────────────────────────────────────────
function drawTelemetry(snap) {
  var history = (snap.telemetry && snap.telemetry.history) || [];
  var a = $("roomsChartA"), b = $("roomsChartB");
  if (!a || !b) return;
  if (history.length < 2) {
    a.innerHTML = emptyHtml("Samples appear after a few refreshes.");
    b.innerHTML = emptyHtml("Samples appear after a few refreshes.");
    return;
  }
  var labels = history.map(function (p) { var d = new Date(p.at); return pad2(d.getHours()) + ":" + pad2(d.getMinutes()); });
  drawChart(a, { labels: labels, tips: labels, a: { name: "Connections", color: SERIES_COLORS[0], values: history.map(function (p) { return p.clients; }), area: true }, b: { name: "Rooms", color: SERIES_COLORS[1], values: history.map(function (p) { return p.rooms; }) } });
  drawChart(b, { labels: labels, tips: labels, a: { name: "RSS MB", color: SERIES_COLORS[0], values: history.map(function (p) { return Math.round(p.rssMb); }), area: true }, b: { name: "Heap MB", color: SERIES_COLORS[1], values: history.map(function (p) { return Math.round(p.heapUsedMb); }) } });
}
function renderRooms(snap) {
  if (!$("roomsBody") || !snap) return;
  var h = snap.host;
  $("roomsHost").innerHTML = '<dl class="kv">' +
    "<dt>Host</dt><dd>" + esc(h.hostname) + " (" + esc(h.platform) + ")</dd>" +
    "<dt>Process</dt><dd>" + esc(h.processId) + " - Node " + esc(h.nodeVersion) + "</dd>" +
    "<dt>CPU</dt><dd>" + esc(h.cpuCount) + " cores, load " + esc(h.loadAvg1m.toFixed(2)) + "</dd>" +
    "<dt>Memory</dt><dd>" + fmtNum(Math.round(h.freeMemMb)) + " MB free of " + fmtNum(Math.round(h.totalMemMb)) + " MB (" + Math.round(h.usedMemPercent) + "% used)</dd>" +
    "<dt>Server time</dt><dd>" + esc(fmtDate(snap.serverTime)) + "</dd></dl>";
  $("roomsBody").innerHTML = snap.rooms.length ? snap.rooms.map(function (room) {
    return "<tr><td><strong>" + esc(room.name) + '</strong><div class="cell-sub mono">' + esc(room.roomId) + "</div></td>" +
      '<td class="num">' + fmtNum(room.clients) + " / " + fmtNum(room.maxClients) + "</td><td>" + (room.locked ? statusDot("warn", "Locked") : statusDot("ok", "Open")) +
      "</td><td>" + esc(room.processId || "-") + "</td><td>" + esc(fmtAgo(room.createdAt)) + "</td></tr>";
  }).join("") : '<tr><td colspan="5">' + emptyHtml("No active rooms.") + "</td></tr>";
  $("roomsActivity").innerHTML = snap.recentActivity.length ? snap.recentActivity.slice().reverse().slice(0, 40).map(function (item) {
    return '<div class="activity-item"><strong>' + esc(item.message) + '</strong><div class="cell-sub">' + esc(item.kind) + " - " + esc(fmtDate(item.at)) + "</div></div>";
  }).join("") : emptyHtml("No activity recorded yet.");
  drawTelemetry(snap);
}
VIEWS.rooms = function () {
  content().innerHTML = pageHead("Rooms & activity", "Live Colyseus rooms and what happened on this process.") +
    '<div class="grid2"><div class="panel"><div class="panel-head"><h2>Connections and rooms</h2></div><div class="chart" id="roomsChartA">' + loadingHtml() + "</div></div>" +
    '<div class="panel"><div class="panel-head"><h2>Memory</h2></div><div class="chart" id="roomsChartB">' + loadingHtml() + "</div></div></div>" +
    '<div class="grid2" style="margin-top:16px"><div class="panel"><div class="panel-head"><h2>Rooms</h2></div><div class="table-wrap"><table><thead><tr><th>Room</th><th class="num">Clients</th><th>State</th><th>Process</th><th>Created</th></tr></thead><tbody id="roomsBody"><tr><td colspan="5">' + loadingHtml() + "</td></tr></tbody></table></div></div>" +
    '<div class="stack"><div class="panel"><div class="panel-head"><h2>Host</h2></div><div class="panel-body" id="roomsHost">' + loadingHtml() + "</div></div>" +
    '<div class="panel"><div class="panel-head"><h2>Recent activity</h2></div><div id="roomsActivity">' + loadingHtml() + "</div></div></div></div>";
  S.onSnapshot = renderRooms;
  if (S.snapshot) renderRooms(S.snapshot);
  refreshStatus();
  S.timer = window.setInterval(refreshStatus, 10000);
};

// ── Runtime ─────────────────────────────────────────────────────────
function renderRuntimeState(snap) {
  var el = $("rtState");
  if (!el || !snap) return;
  var m = snap.maintenance;
  el.innerHTML = m.enabled
    ? '<div class="banner warn"><strong>Maintenance is on</strong>' + (m.message ? " - " + esc(m.message) : "") + '<div class="cell-sub">Since ' + esc(fmtDate(m.startedAt)) + "</div></div>"
    : '<div class="banner ok"><strong>Server is open</strong> - ' + fmtNum(snap.totals.clients) + " connection(s) in " + fmtNum(snap.totals.rooms) + " room(s).</div>";
  var last = snap.lastDisconnect;
  $("rtLast").innerHTML = last
    ? "Last disconnect " + esc(fmtAgo(last.at)) + ": " + fmtNum(last.targetedClients) + " connection(s) in " + fmtNum(last.targetedRooms) + " room(s), code " + esc(last.closeCode) +
      (last.failedRooms.length ? ", " + last.failedRooms.length + " room(s) failed" : "") + "."
    : "No disconnect sent since the process started.";
}
VIEWS.runtime = function () {
  var snap = S.snapshot;
  var enabled = !!(snap && snap.maintenance && snap.maintenance.enabled);
  var action = enabled
    ? '<button class="btn primary" data-act="maintenanceSet" data-enabled="0">Disable maintenance</button>'
    : '<button class="btn primary" data-act="maintenanceSet" data-enabled="1">Enable maintenance</button>';
  content().innerHTML = pageHead("Runtime", "Maintenance, disconnects and live notices for connected players.", action) +
    '<div id="rtState" style="margin-bottom:16px"></div>' +
    '<div class="grid2"><div class="panel"><div class="panel-head"><h2>Maintenance</h2></div><div class="panel-body form">' +
    '<label class="field"><span>Message shown to players</span><textarea id="rtMessage" maxlength="200" placeholder="Server under maintenance. Please try again later."></textarea></label>' +
    '<div class="row"><label class="field"><span>Close code</span><input id="rtCode" type="number" min="4000" max="4999" value="4101" /></label>' +
    '<label class="field"><span>Disconnect reason</span><input id="rtReason" type="text" maxlength="200" value="Maintenance enabled by GM panel." /></label></div>' +
    '<div><button class="btn" data-act="maintenanceKick">Enable and disconnect players</button></div></div></div>' +
    '<div class="stack"><div class="panel"><div class="panel-head"><h2>Disconnect players</h2></div><div class="panel-body form">' +
    '<div class="muted" id="rtLast"></div><div><button class="btn red" data-act="disconnectAll">Disconnect all players</button></div></div></div>' +
    '<div class="panel"><div class="panel-head"><h2>Global notice</h2></div><div class="panel-body form">' +
    '<div class="row"><label class="field"><span>Kind</span><input id="rtKind" type="text" maxlength="32" value="info" /></label>' +
    '<label class="field"><span>Dismiss after (s)</span><input id="rtDismiss" type="number" min="0" max="120" value="8" /></label></div>' +
    '<label class="field"><span>Title</span><input id="rtTitle" type="text" maxlength="80" placeholder="Optional" /></label>' +
    '<label class="field"><span>Message</span><textarea id="rtNotice" maxlength="280" placeholder="Shown to every connected player."></textarea></label>' +
    '<div><button class="btn primary" data-act="noticeSend">Broadcast notice</button></div></div></div></div></div>';
  S.onSnapshot = renderRuntimeState;
  renderRuntimeState(snap);
  refreshStatus();
  S.timer = window.setInterval(refreshStatus, 15000);
};
async function applyMaintenance(enabled, kick) {
  var data = await post("/admin/runtime/maintenance", {
    enabled: enabled, message: $("rtMessage").value, disconnectPlayers: !!kick,
    closeCode: num($("rtCode").value, 4101), reason: $("rtReason").value
  });
  S.snapshot = data.snapshot;
  renderTopStatus();
  toast(enabled ? (kick ? "Maintenance enabled, players disconnected." : "Maintenance enabled.") : "Maintenance disabled.", enabled ? "warn" : "ok");
  VIEWS.runtime();
}
A.maintenanceSet = async function (el) {
  var enable = el.getAttribute("data-enabled") === "1";
  if (enable && !(await confirmAction("Enable maintenance", "New logins are refused with the maintenance message until it is disabled.", "Enable", false))) return;
  await applyMaintenance(enable, false);
};
A.maintenanceKick = async function () {
  if (!(await confirmAction("Enable maintenance and disconnect", "Every connected player is disconnected right away.", "Enable and disconnect"))) return;
  await applyMaintenance(true, true);
};
A.disconnectAll = async function () {
  if (!(await confirmAction("Disconnect all players", "Every live connection is closed with the reason above. Players may reconnect.", "Disconnect"))) return;
  var data = await post("/admin/runtime/disconnect-all", { closeCode: num($("rtCode").value, 4101), reason: $("rtReason").value });
  S.snapshot = data.snapshot;
  toast("Disconnect sent to " + fmtNum(data.disconnect.targetedClients) + " connection(s).", "warn");
  renderRuntimeState(data.snapshot);
};
A.noticeSend = async function () {
  var message = $("rtNotice").value.trim();
  if (!message) { toast("Write a message first.", "warn"); return; }
  var data = await post("/admin/runtime/broadcast-notice", { kind: $("rtKind").value, title: $("rtTitle").value, message: message, dismissSeconds: num($("rtDismiss").value, 8) });
  S.snapshot = data.snapshot;
  toast("Notice sent to connected players.", "ok");
};
`;
