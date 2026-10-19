// GM panel client, part 1: helpers, API client, dialogs, toasts, charts, router. The five script parts are
// concatenated inside one IIFE by `renderGmPanelPage()`. Written with String.raw: client code must not contain
// backticks or dollar-brace sequences, and builds HTML with string concatenation.
export const SCRIPT_CORE = String.raw`
var STORAGE_KEY = "tba_gm_api_key";
var A = {};          // click actions by data-act
var VIEWS = {};      // view renderers by route name
var LOADERS = {};    // list reloaders by data-scope
var S = { catalog: null, snapshot: null, timer: 0, onSnapshot: null, authorized: false, reportsOpen: null };
var dialogSeq = 0;

function $(id) { return document.getElementById(id); }
function esc(value) {
  return String(value === null || value === undefined ? "" : value).replace(/[&<>"']/g, function (ch) {
    return ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;";
  });
}
function getKey() { try { return window.localStorage.getItem(STORAGE_KEY) || ""; } catch (e) { return ""; } }
function setKey(value) {
  try { if (value) window.localStorage.setItem(STORAGE_KEY, value); else window.localStorage.removeItem(STORAGE_KEY); } catch (e) { /* storage blocked */ }
}
function num(value, fallback) { var n = Number(value); return isFinite(n) ? n : (fallback === undefined ? 0 : fallback); }
function fmtNum(value) { return Number(value || 0).toLocaleString("en-US"); }
var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function pad2(n) { return (n < 10 ? "0" : "") + n; }
function fmtDate(value) {
  if (!value) return "-";
  var d = new Date(value);
  if (isNaN(d.getTime())) return "-";
  return MONTHS[d.getMonth()] + " " + pad2(d.getDate()) + ", " + d.getFullYear() + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}
function fmtDay(value) {
  var d = new Date(value);
  return isNaN(d.getTime()) ? "-" : MONTHS[d.getMonth()] + " " + pad2(d.getDate()) + ", " + d.getFullYear();
}
function fmtAgo(value) {
  if (!value) return "never";
  var diff = (Date.now() - new Date(value).getTime()) / 1000;
  if (isNaN(diff)) return "-";
  if (diff < 0) return "in the future";
  if (diff < 60) return "just now";
  if (diff < 3600) return Math.floor(diff / 60) + " min ago";
  if (diff < 86400) return Math.floor(diff / 3600) + " h ago";
  if (diff < 86400 * 30) return Math.floor(diff / 86400) + " d ago";
  return fmtDay(value);
}
function fmtDuration(seconds) {
  var s = Math.floor(num(seconds));
  var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 0 ? d + "d " + h + "h" : h > 0 ? h + "h " + m + "m" : m + "m " + (s % 60) + "s";
}
function fmtBytes(bytes) {
  var n = num(bytes);
  return n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB";
}
function isForever(value) { var t = new Date(value).getTime(); return !isNaN(t) && t - Date.now() > 50 * 365 * 24 * 3600 * 1000; }
function shortId(value) { return String(value || "").slice(0, 8); }
function qs(params) {
  var parts = [];
  Object.keys(params).forEach(function (key) {
    var value = params[key];
    if (value === null || value === undefined || value === "") return;
    parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(value));
  });
  return parts.length ? "?" + parts.join("&") : "";
}

var ICONS = {
  overview: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>',
  runtime: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  rooms: '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>',
  players: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><circle cx="17" cy="9" r="2.5"/><path d="M17 14c2.6 0 4.5 1.8 4.5 5"/>',
  guilds: '<path d="M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6l8-3z"/>',
  chat: '<path d="M4 5h16v11H9l-5 4V5z"/>',
  reports: '<path d="M5 21V4"/><path d="M5 4h12l-2 4 2 4H5"/>',
  grants: '<rect x="3" y="8" width="18" height="4"/><path d="M5 12v9h14v-9M12 8v13"/><path d="M12 8c-2-4-6-3-5 0 .6 1.7 3 1 5 0zM12 8c2-4 6-3 5 0-.6 1.7-3 1-5 0z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="1"/><path d="M3 7l9 6 9-6"/>',
  audit: '<rect x="5" y="3" width="14" height="18" rx="1"/><path d="M9 8h6M9 12h6M9 16h4"/>',
  config: '<path d="M6 3h8l4 4v14H6V3z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
  logs: '<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M7 9l3 3-3 3M13 15h4"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l5 5"/>',
  caret: '<path d="M6 9l6 6 6-6"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  columns: '<rect x="3" y="5" width="18" height="14" rx="1"/><path d="M9 5v14M15 5v14"/>',
  back: '<path d="M15 6l-6 6 6 6"/>'
};
function icon(name, size) {
  var s = size || 18;
  return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || "") + "</svg>";
}

// ── API ─────────────────────────────────────────────────────────────
// Plain wording for error codes the server sends without a detail text.
var ERROR_TEXT = {
  EMPTY: "The nickname is empty.", TOO_SHORT: "The nickname is shorter than the minimum length.", TOO_LONG: "The nickname is longer than the maximum length.",
  INVALID_CHARS: "The nickname has characters the game rules do not allow.", PROFILE_NAME_TAKEN: "Another player already uses that nickname.",
  SERVER_ERROR: "The server could not handle the request. Check the Logs view for the cause."
};
async function api(path, options) {
  var opts = options || {};
  var headers = { "x-config-api-key": getKey() };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  var response;
  try {
    response = await fetch(path, { method: opts.method || "GET", headers: headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  } catch (networkError) {
    throw new Error("Cannot reach the server. Check that it is running, then try again.");
  }
  var text = await response.text();
  var data = null;
  try { data = text ? JSON.parse(text) : {}; } catch (e) { data = null; }
  if (response.status === 401) {
    S.authorized = false;
    renderSession();
    throw new Error("The admin key was rejected. Set a valid key.");
  }
  if (!response.ok || !data || data.ok === false) {
    var detail = data && data.detail !== null && data.detail !== undefined ? (typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail)) : "";
    var code = data && data.error ? data.error : "HTTP " + response.status;
    if (!detail && ERROR_TEXT[code]) throw new Error(ERROR_TEXT[code]);
    throw new Error(detail ? (code === "INVALID_REQUEST" ? detail : code + ": " + detail) : code);
  }
  S.authorized = true;
  return data;
}
function post(path, body) { return api(path, { method: "POST", body: body || {} }); }
var PLAYERS = "/admin/runtime/players/";
function playerPath(userId, tail) { return PLAYERS + encodeURIComponent(userId) + (tail ? "/" + tail : ""); }

// ── Feedback ────────────────────────────────────────────────────────
function toast(message, tone) {
  var root = $("toasts");
  var el = document.createElement("div");
  el.className = "toast " + (tone || "");
  el.textContent = message;
  root.appendChild(el);
  window.setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, tone === "bad" ? 8000 : 4500);
}
function fail(error) { toast(error && error.message ? error.message : "Request failed.", "bad"); }

function fieldHtml(f) {
  var id = "f_" + f.name;
  var control;
  var value = f.value === undefined || f.value === null ? "" : f.value;
  if (f.type === "select") {
    control = '<select id="' + id + '" name="' + esc(f.name) + '">' + (f.options || []).map(function (o) {
      return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(value) ? " selected" : "") + ">" + esc(o[1]) + "</option>";
    }).join("") + "</select>";
  } else if (f.type === "textarea") {
    control = '<textarea id="' + id + '" name="' + esc(f.name) + '" placeholder="' + esc(f.placeholder || "") + '" maxlength="' + esc(f.maxlength || 1000) + '">' + esc(value) + "</textarea>";
  } else if (f.type === "checkbox") {
    return '<label class="check"><input type="checkbox" name="' + esc(f.name) + '"' + (value ? " checked" : "") + " /><span>" + esc(f.label) + "</span></label>";
  } else if (f.type === "lookup") {
    return lookupHtml(id, f.label, f.placeholder, f.name);
  } else {
    control = '<input id="' + id + '" name="' + esc(f.name) + '" type="' + (f.type === "number" ? "number" : f.type === "password" ? "password" : "text") + '" value="' + esc(value) + '"' +
      (f.min !== undefined ? ' min="' + esc(f.min) + '"' : "") + (f.max !== undefined ? ' max="' + esc(f.max) + '"' : "") +
      (f.maxlength ? ' maxlength="' + esc(f.maxlength) + '"' : "") + ' placeholder="' + esc(f.placeholder || "") + '" autocomplete="off"' +
      (f.list ? ' list="' + esc(f.list) + '"' : "") + " />";
  }
  return '<label class="field"><span>' + esc(f.label) + "</span>" + control + (f.hint ? "<small>" + esc(f.hint) + "</small>" : "") + "</label>";
}

// Modal dialog: confirmation or form. Resolves with the values (true for a plain confirmation) or null when cancelled.
function dialog(opts) {
  return new Promise(function (resolve) {
    var root = $("modalRoot");
    var fields = opts.fields || [];
    var html = '<div class="backdrop" data-backdrop="1"><form class="modal' + (opts.wide ? " wide" : "") + '" autocomplete="off">' +
      "<h3>" + esc(opts.title) + "</h3><div class=\"body\">" +
      (opts.text ? '<p style="margin:0 0 14px">' + esc(opts.text) + "</p>" : "") +
      (opts.html || "") +
      (fields.length ? '<div class="form">' + fields.map(fieldHtml).join("") + "</div>" : "") +
      '</div><div class="foot"><button type="button" class="btn" data-cancel="1">Cancel</button>' +
      '<button type="submit" class="btn ' + (opts.danger ? "danger" : "primary") + '">' + esc(opts.confirm || "OK") + "</button></div></form></div>";
    root.innerHTML = html;
    var form = root.querySelector("form");
    var done = false;
    function finish(value) {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKey, true);
      root.innerHTML = "";
      resolve(value);
    }
    function onKey(event) { if (event.key === "Escape") { event.preventDefault(); finish(null); } }
    document.addEventListener("keydown", onKey, true);
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var values = {};
      fields.forEach(function (f) {
        var el = form.elements[f.name];
        if (!el) return;
        if (f.type === "checkbox") values[f.name] = !!el.checked;
        else if (f.type === "number") values[f.name] = el.value === "" ? null : Number(el.value);
        else if (f.type === "lookup") values[f.name] = lookupValue(el);
        else values[f.name] = String(el.value || "").trim();
      });
      finish(fields.length ? values : true);
    });
    root.querySelector("[data-cancel]").addEventListener("click", function () { finish(null); });
    root.querySelector("[data-backdrop]").addEventListener("mousedown", function (event) { if (event.target.hasAttribute("data-backdrop")) finish(null); });
    var first = form.querySelector("input, select, textarea");
    if (first) first.focus();
    else form.querySelector('button[type="submit"]').focus();
  });
}
function confirmAction(title, text, label, danger) {
  return dialog({ title: title, text: text, confirm: label || "Confirm", danger: danger !== false });
}

// ── Player lookup (autocomplete) ────────────────────────────────────
function lookupHtml(id, label, placeholder, name) {
  return '<div class="lookup"><label class="field"><span>' + esc(label || "Player") + '</span><input type="text" id="' + id + '" name="' + esc(name || id) +
    '" data-lookup="1" maxlength="120" autocomplete="off" placeholder="' + esc(placeholder || "Nickname, username, email or id") + '" /></label>' +
    '<div class="lookup-list hidden" data-lookup-list="' + id + '"></div></div>';
}
function lookupValue(input) { return (input.dataset.userId && input.dataset.label === input.value ? input.dataset.userId : input.value).trim(); }
var lookupTimer = 0;
document.addEventListener("input", function (event) {
  var input = event.target;
  if (!input || !input.hasAttribute || !input.hasAttribute("data-lookup")) return;
  delete input.dataset.userId;
  var list = document.querySelector('[data-lookup-list="' + input.id + '"]');
  window.clearTimeout(lookupTimer);
  var query = input.value.trim();
  if (query.length < 2) { list.classList.add("hidden"); return; }
  lookupTimer = window.setTimeout(async function () {
    try {
      var data = await api("/admin/runtime/players/search" + qs({ q: query, limit: 8 }));
      list.innerHTML = data.results.length ? data.results.map(function (item) {
        return '<button type="button" data-act="lookupPick" data-input="' + esc(input.id) + '" data-id="' + esc(item.userId) + '" data-label="' + esc(item.name || item.username) + '">' +
          "<strong>" + esc(item.name || item.username) + '</strong><div class="cell-sub">' + esc(item.name ? item.username + " - " : "") + esc(item.email || "guest") + " - " + esc(shortId(item.userId)) + "</div></button>";
      }).join("") : '<div class="state" style="padding:14px">No players found.</div>';
      list.classList.remove("hidden");
    } catch (error) { list.classList.add("hidden"); }
  }, 220);
});
A.lookupPick = function (el) {
  var input = $(el.dataset.input);
  input.value = el.dataset.label;
  input.dataset.userId = el.dataset.id;
  input.dataset.label = el.dataset.label;
  el.parentNode.classList.add("hidden");
  input.dispatchEvent(new Event("change", { bubbles: true }));
};

// ── Table / tabs helpers ────────────────────────────────────────────
function statusDot(tone, text) { return '<span class="st ' + tone + '"><i></i>' + esc(text) + "</span>"; }
function loadingHtml(text) { return '<div class="state"><div class="spinner"></div>' + esc(text || "Loading...") + "</div>"; }
function emptyHtml(text) { return '<div class="state">' + esc(text) + "</div>"; }
function errorHtml(message, retryAct) {
  return '<div class="state"><div style="color:var(--red);margin-bottom:12px">' + esc(message) + "</div>" +
    (retryAct ? '<button class="btn" data-act="' + retryAct + '">Retry</button>' : "") + "</div>";
}
function tabsHtml(items, active, act, extra) {
  return '<div class="tabs">' + items.map(function (item) {
    return '<button class="tab' + (item.id === active ? " active" : "") + '" data-act="' + act + '" data-tab="' + esc(item.id) + '"' + (extra || "") + ">" + esc(item.label) +
      (item.count !== undefined && item.count !== null ? '<span class="badge">' + fmtNum(item.count) + "</span>" : "") + "</button>";
  }).join("") + "</div>";
}
function sortTh(label, key, state, scope, numeric) {
  var on = state.sort === key;
  return '<th class="sortable' + (numeric ? " num" : "") + '" data-act="sort" data-scope="' + scope + '" data-key="' + key + '">' + esc(label) +
    (on ? '<span class="arrow">' + icon(state.dir === "asc" ? "up" : "down", 14) + "</span>" : "") + "</th>";
}
function searchRow(id, placeholder, value, right) {
  return '<div class="searchrow">' + icon("search", 20) + '<input type="search" id="' + id + '" data-search="' + id + '" placeholder="' + esc(placeholder) + '" value="' + esc(value || "") + '" />' + (right || "") + "</div>";
}
function pagerHtml(st, total, scope) {
  var from = total === 0 ? 0 : (st.page - 1) * st.pageSize + 1;
  var to = Math.min(total, st.page * st.pageSize);
  return '<div class="pager"><span>' + fmtNum(from) + " - " + fmtNum(to) + " of " + fmtNum(total) + '</span><span class="btns">' +
    '<select data-change="pageSize" data-scope="' + scope + '">' + [25, 50, 100].map(function (n) {
      return '<option value="' + n + '"' + (n === st.pageSize ? " selected" : "") + ">" + n + " / page</option>";
    }).join("") + "</select>" +
    '<button class="btn small" data-act="page" data-scope="' + scope + '" data-dir="-1"' + (st.page <= 1 ? " disabled" : "") + ">Previous</button>" +
    '<button class="btn small" data-act="page" data-scope="' + scope + '" data-dir="1"' + (to >= total ? " disabled" : "") + ">Next</button></span></div>";
}
A.sort = function (el) {
  var st = S[el.dataset.scope];
  var key = el.dataset.key;
  if (st.sort === key) st.dir = st.dir === "asc" ? "desc" : "asc";
  else { st.sort = key; st.dir = key === "name" ? "asc" : "desc"; }
  st.page = 1;
  LOADERS[el.dataset.scope]();
};
A.page = function (el) { var st = S[el.dataset.scope]; st.page = Math.max(1, st.page + Number(el.dataset.dir)); LOADERS[el.dataset.scope](); };
A.filterTab = function (el) { var st = S[el.dataset.scope]; st.filter = el.dataset.tab; st.page = 1; LOADERS[el.dataset.scope](); };
var searchTimer = 0;
document.addEventListener("input", function (event) {
  var el = event.target;
  if (!el || !el.hasAttribute || !el.hasAttribute("data-search")) return;
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(function () {
    var st = S[el.getAttribute("data-search")];
    if (!st) return;
    st.q = el.value.trim();
    st.page = 1;
    LOADERS[el.getAttribute("data-search")]();
  }, 300);
});
document.addEventListener("input", function (event) {
  var el = event.target;
  var kind = el && el.getAttribute ? el.getAttribute("data-input-act") : null;
  if (kind && A[kind]) Promise.resolve(A[kind](el, event)).catch(fail);
});
document.addEventListener("change", function (event) {
  var el = event.target;
  if (!el || !el.getAttribute) return;
  var kind = el.getAttribute("data-change");
  if (kind === "pageSize") { var st = S[el.dataset.scope]; st.pageSize = Number(el.value); st.page = 1; LOADERS[el.dataset.scope](); }
  else if (kind && A[kind]) Promise.resolve(A[kind](el, event)).catch(fail);
});

// ── Charts ──────────────────────────────────────────────────────────
function niceStep(value) {
  if (value <= 1) return 1;
  var p = Math.pow(10, Math.floor(Math.log(value) / Math.LN10));
  var n = value / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}
function axisMax(values) {
  var max = 0;
  values.forEach(function (v) { if (v > max) max = v; });
  return max <= 4 ? 4 : niceStep(max / 4) * 4;
}
function shortNum(v) { return v >= 1e6 ? (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : v >= 1e4 ? (v / 1e3).toFixed(1).replace(/\.0$/, "") + "k" : fmtNum(v); }
// model: { labels: [], tips: [], a: { name, color, values, area }, b: { name, color, values } | null }
function drawChart(el, model) {
  var width = Math.max(320, el.clientWidth - 48);
  var height = 280, left = 52, right = model.b ? 52 : 16, top = 14, bottom = 30;
  var plotW = width - left - right, plotH = height - top - bottom;
  var count = model.labels.length;
  var maxA = axisMax(model.a.values), maxB = model.b ? axisMax(model.b.values) : 1;
  function px(i) { return left + (count <= 1 ? plotW / 2 : (plotW * i) / (count - 1)); }
  function py(v, max) { return top + plotH - (plotH * v) / max; }
  function path(values, max) { return values.map(function (v, i) { return (i ? "L" : "M") + px(i).toFixed(1) + " " + py(v, max).toFixed(1); }).join(" "); }
  var svg = '<svg viewBox="0 0 ' + width + " " + height + '" width="' + width + '" height="' + height + '">';
  for (var g = 0; g <= 4; g++) {
    var y = top + (plotH * g) / 4;
    svg += '<line x1="' + left + '" x2="' + (width - right) + '" y1="' + y + '" y2="' + y + '" stroke="#e8e2d4" />';
    svg += '<text x="' + (left - 10) + '" y="' + (y + 4) + '" text-anchor="end">' + shortNum(maxA - (maxA * g) / 4) + "</text>";
    if (model.b) svg += '<text x="' + (width - right + 10) + '" y="' + (y + 4) + '">' + shortNum(maxB - (maxB * g) / 4) + "</text>";
  }
  var step = Math.max(1, Math.ceil(count / 8));
  model.labels.forEach(function (label, i) {
    if (i % step === 0 || i === count - 1) svg += '<text x="' + px(i) + '" y="' + (height - 8) + '" text-anchor="middle">' + esc(label) + "</text>";
  });
  if (model.a.area) svg += '<path d="' + path(model.a.values, maxA) + " L" + px(count - 1) + " " + (top + plotH) + " L" + px(0) + " " + (top + plotH) + ' Z" fill="' + model.a.color + '" fill-opacity="0.1" />';
  svg += '<path d="' + path(model.a.values, maxA) + '" fill="none" stroke="' + model.a.color + '" stroke-width="2" stroke-linejoin="round" />';
  if (model.b) svg += '<path d="' + path(model.b.values, maxB) + '" fill="none" stroke="' + model.b.color + '" stroke-width="2" stroke-linejoin="round" />';
  svg += '<line class="hair" x1="0" x2="0" y1="' + top + '" y2="' + (top + plotH) + '" stroke="#a09cb8" stroke-dasharray="3 3" style="display:none" />';
  svg += '<circle class="dotA" r="4" fill="' + model.a.color + '" stroke="#fff" stroke-width="2" style="display:none" />';
  if (model.b) svg += '<circle class="dotB" r="4" fill="' + model.b.color + '" stroke="#fff" stroke-width="2" style="display:none" />';
  svg += "</svg>";
  el.innerHTML = svg + '<div class="tooltip hidden"></div>';
  var tip = el.querySelector(".tooltip");
  var hair = el.querySelector(".hair"), dotA = el.querySelector(".dotA"), dotB = el.querySelector(".dotB");
  var box = el.querySelector("svg");
  function show(event) {
    var rect = box.getBoundingClientRect();
    var x = ((event.clientX - rect.left) / rect.width) * width;
    var index = Math.max(0, Math.min(count - 1, Math.round(count <= 1 ? 0 : ((x - left) / plotW) * (count - 1))));
    var cx = px(index);
    hair.setAttribute("x1", cx); hair.setAttribute("x2", cx); hair.style.display = "";
    dotA.setAttribute("cx", cx); dotA.setAttribute("cy", py(model.a.values[index], maxA)); dotA.style.display = "";
    if (dotB) { dotB.setAttribute("cx", cx); dotB.setAttribute("cy", py(model.b.values[index], maxB)); dotB.style.display = ""; }
    tip.innerHTML = "<b>" + esc(model.tips[index]) + "</b>" + esc(model.a.name) + ": <b style=\"display:inline\">" + fmtNum(model.a.values[index]) + "</b>" +
      (model.b ? "<br>" + esc(model.b.name) + ": <b style=\"display:inline\">" + fmtNum(model.b.values[index]) + "</b>" : "");
    tip.classList.remove("hidden");
    var scale = rect.width / width;
    var tipLeft = cx * scale + 24 + 14;
    if (tipLeft + tip.offsetWidth > el.clientWidth - 8) tipLeft = cx * scale + 24 - 14 - tip.offsetWidth;
    tip.style.left = Math.max(8, tipLeft) + "px";
    tip.style.top = Math.max(0, Math.min(py(model.a.values[index], maxA), model.b ? py(model.b.values[index], maxB) : 1e9) * scale - 20) + "px";
  }
  box.onmousemove = show;
  box.onmouseleave = function () {
    tip.classList.add("hidden");
    hair.style.display = "none"; dotA.style.display = "none"; if (dotB) dotB.style.display = "none";
  };
}

// ── Session, status, router ─────────────────────────────────────────
function renderSession() {
  var has = !!getKey();
  $("sessionName").textContent = has ? "Admin" : "No session";
  $("sessionSub").textContent = has ? (S.authorized ? "Key accepted" : "Key stored in this browser") : "Set the admin key";
  $("sessionAvatar").textContent = has ? "A" : "?";
}
function renderTopStatus() {
  var snap = S.snapshot;
  var dot = $("topStatus");
  if (!snap) { dot.className = "st"; $("topStatusText").textContent = "Status unknown"; return; }
  var maintenance = snap.maintenance && snap.maintenance.enabled;
  dot.className = "st " + (maintenance ? "warn" : "ok");
  $("topStatusText").textContent = (maintenance ? "Maintenance - " : "Online - ") + fmtNum(snap.totals.clients) + " connections";
}
// Sidebar badge of the Reports item; a toast tells when new reports arrived since the last poll.
function setReportsBadge(open) {
  if (open === null || open === undefined) return;
  var count = Math.max(0, num(open));
  var badge = $("navReportsBadge");
  if (badge) {
    badge.textContent = count > 99 ? "99+" : String(count);
    badge.classList.toggle("hidden", count === 0);
  }
  if (S.reportsOpen !== null && count > S.reportsOpen) {
    var added = count - S.reportsOpen;
    toast(added + (added === 1 ? " new player report" : " new player reports") + " waiting.", "warn");
  }
  S.reportsOpen = count;
}
async function refreshStatus() {
  if (!getKey()) return;
  try {
    var data = await api("/admin/runtime/status");
    S.snapshot = data.snapshot;
    renderTopStatus();
    if (data.reports) setReportsBadge(data.reports.open);
    if (S.onSnapshot) S.onSnapshot(data.snapshot);
  } catch (error) {
    S.snapshot = null;
    renderTopStatus();
  }
}
async function loadCatalog() {
  if (S.catalog || !getKey()) return S.catalog;
  try { S.catalog = await api("/admin/runtime/catalog/summary"); } catch (error) { S.catalog = null; }
  fillCatalogLists();
  return S.catalog;
}
function stopTimers() { window.clearInterval(S.timer); S.timer = 0; S.onSnapshot = null; }
function parseRoute() {
  var parts = (window.location.hash || "#overview").slice(1).split("/").map(function (p) { return decodeURIComponent(p); });
  return { view: parts[0] || "overview", id: parts[1] || null, tab: parts[2] || null };
}
function go(hash) { if (window.location.hash === hash) route(); else window.location.hash = hash; }
function content() { return $("content"); }
function pageHead(title, sub, actionsHtml, crumb) {
  return '<div class="page-head"><div>' + (crumb || "") + "<h1>" + esc(title) + "</h1>" + (sub ? '<div class="sub">' + sub + "</div>" : "") + '</div><div class="page-actions">' + (actionsHtml || "") + "</div></div>";
}
function route() {
  var r = parseRoute();
  stopTimers();
  var name = VIEWS[r.view] ? r.view : "overview";
  Array.prototype.forEach.call(document.querySelectorAll(".nav-item"), function (item) {
    item.classList.toggle("active", item.getAttribute("data-view") === name);
  });
  if (!getKey()) {
    content().innerHTML = pageHead("Admin session", "") + '<div class="panel"><div class="state">Set the admin key to use the panel.<br><br><button class="btn primary" data-act="session">Set admin key</button></div></div>';
    return;
  }
  window.scrollTo(0, 0);
  VIEWS[name](r);
}
A.session = async function () {
  var values = await dialog({
    title: "Admin session",
    text: "The key is kept only in this browser and sent as the x-config-api-key header.",
    fields: [{ name: "key", label: "Admin key", type: "password", value: getKey() }],
    confirm: "Save"
  });
  if (values === null) return;
  setKey(values.key);
  S.catalog = null;
  S.authorized = false;
  renderSession();
  refreshStatus();
  route();
};
A.nav = function (el) { go("#" + el.getAttribute("data-view")); };
A.go = function (el) { go(el.getAttribute("data-to")); };
A.reload = function () { route(); };
A.copy = function (el) {
  var text = el.getAttribute("data-text") || "";
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { toast("Copied.", "ok"); }, function () { toast(text); });
  else toast(text);
};
document.addEventListener("click", function (event) {
  var el = event.target.closest ? event.target.closest("[data-act]") : null;
  if (!el) {
    Array.prototype.forEach.call(document.querySelectorAll(".lookup-list"), function (list) { list.classList.add("hidden"); });
    return;
  }
  var handler = A[el.getAttribute("data-act")];
  if (!handler) return;
  event.preventDefault();
  Promise.resolve(handler(el, event)).catch(fail);
});
`;
