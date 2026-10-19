// GM panel client, part 6: Logs (server log entries with filters, expandable details, auto-refresh and copy).
// Same rules as the other parts: String.raw, no backticks or dollar-brace sequences, HTML built by concatenation.
export const SCRIPT_LOGS = String.raw`
// ── Logs ────────────────────────────────────────────────────────────
var LOG_LEVELS = ["error", "warn", "info", "debug"];
var LOG_RANGES = [["15m", "Last 15 minutes", 15 * 60000], ["1h", "Last hour", 3600000], ["6h", "Last 6 hours", 6 * 3600000], ["24h", "Last 24 hours", 86400000], ["7d", "Last 7 days", 7 * 86400000], ["all", "All retained", 0]];
S.logs = { levels: {}, scope: "", q: "", range: "1h", entries: [], nextBefore: null, source: "", summary: null, auto: false, open: {}, loading: false };

function logRangeMs(id) {
  for (var i = 0; i < LOG_RANGES.length; i++) if (LOG_RANGES[i][0] === id) return LOG_RANGES[i][2];
  return 0;
}
function logSelectedLevels() {
  return LOG_LEVELS.filter(function (level) { return S.logs.levels[level]; });
}
function logQuery(before) {
  var st = S.logs, ms = logRangeMs(st.range);
  return qs({ levels: logSelectedLevels().join(","), scope: st.scope, q: st.q, from: ms ? new Date(Date.now() - ms).toISOString() : "", before: before, limit: 100 });
}
function logEntryText(entry) {
  return "[" + entry.time + "] " + String(entry.level).toUpperCase() + " [" + entry.scope + "] " + entry.message + (entry.repeats > 1 ? " (x" + entry.repeats + ")" : "") +
    (entry.userId ? "\nuser: " + entry.userId : "") + (entry.room ? "\nroom: " + entry.room : "") + "\npid: " + entry.pid + (entry.details ? "\n\n" + entry.details : "");
}
function levelPill(level) { return '<span class="lvl ' + esc(level) + '">' + esc(level) + "</span>"; }

function renderLogChips() {
  var st = S.logs, el = $("lgChips");
  if (!el) return;
  var counts = st.summary ? st.summary.counts : {};
  el.innerHTML = LOG_LEVELS.map(function (level) {
    return '<button type="button" class="chip' + (st.levels[level] ? " on" : "") + '" data-act="lgLevel" data-level="' + level + '" title="Entries in the last 24 hours">' + levelPill(level) + "<b>" + fmtNum(counts[level] || 0) + "</b></button>";
  }).join("") + '<span class="chip-note">last 24 hours</span>';
}
function renderLogFilters() {
  var st = S.logs, el = $("lgFilters");
  if (!el) return;
  var scopes = st.summary ? st.summary.scopes : [];
  var known = scopes.some(function (item) { return item.scope === st.scope; });
  el.innerHTML = '<label class="field"><span>Scope</span><select data-change="lgFilter" data-key="scope"><option value="">All scopes</option>' +
    (st.scope && !known ? '<option value="' + esc(st.scope) + '" selected>' + esc(st.scope) + "</option>" : "") +
    scopes.map(function (item) { return '<option value="' + esc(item.scope) + '"' + (item.scope === st.scope ? " selected" : "") + ">" + esc(item.scope) + " (" + fmtNum(item.count) + ")</option>"; }).join("") + "</select></label>" +
    '<label class="field"><span>Time range</span><select data-change="lgFilter" data-key="range">' +
    LOG_RANGES.map(function (r) { return '<option value="' + r[0] + '"' + (r[0] === st.range ? " selected" : "") + ">" + esc(r[1]) + "</option>"; }).join("") + "</select></label>" +
    '<label class="field" style="flex:1 1 240px"><span>Search message or details</span><input type="search" id="lgSearch" data-search="logs" value="' + esc(st.q) + '" placeholder="Text to find" maxlength="120" /></label>';
}
function renderLogStatus() {
  var st = S.logs, el = $("lgStatus");
  if (!el) return;
  var sum = st.summary, parts = [];
  if (st.source === "memory") parts.push('<span class="st warn"><i></i>Database unavailable: showing the memory buffer only</span>');
  if (sum && sum.sink && sum.sink.pending > 0) parts.push(fmtNum(sum.sink.pending) + " waiting to be stored");
  if (sum && sum.sink && sum.sink.dropped > 0) parts.push(fmtNum(sum.sink.dropped) + " not stored (flood)");
  if (sum) parts.push("kept " + fmtNum(sum.retentionDays) + " days");
  el.innerHTML = parts.join(" - ");
}
function renderLogTable() {
  var st = S.logs, el = $("lgTable");
  if (!el) return;
  if (!st.entries.length) { el.innerHTML = emptyHtml("No log entries match these filters."); return; }
  var rows = st.entries.map(function (e) {
    var open = !!st.open[e.id];
    var line = '<tr class="clickable log-row' + (open ? " open" : "") + '" data-act="lgToggle" data-id="' + e.id + '"><td class="nowrap">' + esc(fmtDate(e.time)) + ":" + pad2(new Date(e.time).getSeconds()) + "</td><td>" + levelPill(e.level) +
      '</td><td class="nowrap">' + esc(e.scope) + '</td><td class="log-msg">' + esc(e.message) + (e.repeats > 1 ? ' <span class="badge">x' + fmtNum(e.repeats) + "</span>" : "") +
      (e.details ? ' <span class="muted" title="Has details">+</span>' : "") + "</td></tr>";
    if (!open) return line;
    var meta = [];
    if (e.userId) meta.push("player " + e.userId);
    if (e.room) meta.push("room " + e.room);
    meta.push("pid " + e.pid);
    return line + '<tr class="log-detail"><td colspan="4"><div class="cell-sub" style="margin-bottom:8px">' + esc(meta.join(" - ")) + '</div><pre class="logpre">' + esc(e.message + (e.details ? "\n\n" + e.details : "")) +
      '</pre><div style="margin-top:8px"><button class="btn small" data-act="lgCopy" data-id="' + e.id + '">Copy entry</button>' +
      (e.userId ? ' <button class="btn small" data-act="go" data-to="#players/' + encodeURIComponent(e.userId) + '">Open player</button>' : "") + "</div></td></tr>";
  }).join("");
  el.innerHTML = '<div class="table-wrap"><table><thead><tr><th>Time</th><th>Level</th><th>Scope</th><th>Message</th></tr></thead><tbody>' + rows + "</tbody></table></div>" +
    '<div class="pager"><span>' + fmtNum(st.entries.length) + " loaded</span>" +
    (st.nextBefore ? '<span class="btns" id="lgMore"><button class="btn small" data-act="lgMore">Load older</button></span>' : "<span>End of the retained entries</span>") + "</div>";
  watchLogsEnd();
}
// Infinite loading: when the browser supports it, reaching the end of the list loads the next page.
var logObserver = null;
function watchLogsEnd() {
  if (typeof IntersectionObserver === "undefined") return;
  if (logObserver) { logObserver.disconnect(); logObserver = null; }
  var more = $("lgMore");
  if (!more) return;
  logObserver = new IntersectionObserver(function (items) {
    if (items.some(function (item) { return item.isIntersecting; }) && !S.logs.loading && S.logs.nextBefore) LOADERS.logs(true);
  });
  logObserver.observe(more);
}
LOADERS.logs = async function (more) {
  var st = S.logs;
  if (!$("lgTable") || st.loading) return;
  st.loading = true;
  if (!more && !st.entries.length) $("lgTable").innerHTML = loadingHtml("Loading logs...");
  try {
    var requests = [api("/admin/runtime/logs" + logQuery(more === true ? st.nextBefore : null))];
    if (more !== true) requests.push(api("/admin/runtime/logs/summary"));
    var results = await Promise.all(requests);
    var page = results[0];
    st.entries = more === true ? st.entries.concat(page.entries) : page.entries;
    st.nextBefore = page.nextBefore;
    st.source = page.source;
    if (results[1]) st.summary = results[1].summary;
  } catch (error) {
    st.loading = false;
    if ($("lgTable")) $("lgTable").innerHTML = errorHtml(error.message, "lgReload");
    return;
  }
  st.loading = false;
  renderLogChips();
  renderLogFilters();
  renderLogStatus();
  renderLogTable();
};
A.lgReload = function () { return LOADERS.logs(false); };
A.lgMore = function () { return LOADERS.logs(true); };
A.lgLevel = function (el) {
  var level = el.getAttribute("data-level");
  S.logs.levels[level] = !S.logs.levels[level];
  S.logs.entries = [];
  renderLogChips();
  LOADERS.logs(false);
};
A.lgFilter = function (el) {
  S.logs[el.getAttribute("data-key")] = el.value;
  S.logs.entries = [];
  LOADERS.logs(false);
};
A.lgToggle = function (el) {
  var id = el.getAttribute("data-id");
  if (S.logs.open[id]) delete S.logs.open[id]; else S.logs.open[id] = true;
  renderLogTable();
};
A.lgCopy = function (el) {
  var id = Number(el.getAttribute("data-id"));
  var entry = S.logs.entries.filter(function (item) { return item.id === id; })[0];
  if (!entry) return;
  var text = logEntryText(entry);
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { toast("Log entry copied.", "ok"); }, function () { toast(text); });
  else toast(text);
};
function setLogAutoRefresh() {
  window.clearInterval(S.timer);
  S.timer = 0;
  if (S.logs.auto) S.timer = window.setInterval(function () { if (!S.logs.loading) LOADERS.logs(false); }, 5000);
  var button = $("lgAuto");
  if (button) { button.textContent = S.logs.auto ? "Auto-refresh: on" : "Auto-refresh: off"; button.classList.toggle("primary", S.logs.auto); }
}
A.lgAuto = function () { S.logs.auto = !S.logs.auto; setLogAutoRefresh(); };
VIEWS.logs = async function () {
  var st = S.logs;
  st.entries = [];
  st.open = {};
  content().innerHTML = pageHead("Logs", 'Everything the server logs: game services, Colyseus, uncaught errors. <span id="lgStatus"></span>',
    '<button class="btn" id="lgAuto" data-act="lgAuto">Auto-refresh: off</button><button class="btn" data-act="reload">Refresh</button>') +
    '<div class="panel"><div class="chips" id="lgChips"></div><div class="filters" id="lgFilters"></div><div id="lgTable">' + loadingHtml() + "</div></div>";
  renderLogChips();
  renderLogFilters();
  await LOADERS.logs(false);
  setLogAutoRefresh();
};
`;
