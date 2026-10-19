// GM panel stylesheet. Own identity: deep indigo header and gold accent on warm paper tones, serif headings (system
// fonts only). No external resources (the page must not contain url() or absolute URLs, see gm_panel_page_test).
export const GM_STYLES = String.raw`
:root {
  --indigo: #4338b0;
  --indigo-dark: #342b94;
  --indigo-deep: #1c1856;
  --indigo-mid: #2c2575;
  --indigo-tint: #eceafb;
  --gold: #f0b429;
  --gold-dark: #d99a0e;
  --gold-soft: #fdf3d6;
  --blue: var(--indigo);
  --blue-dark: var(--indigo-dark);
  --text: #231f3f;
  --muted: #6a6786;
  --line: #e8e2d4;
  --line-strong: #d3cbb8;
  --page: #f7f4ed;
  --panel: #ffffff;
  --side: #efe9dc;
  --side-active: #ffffff;
  --green: #1b7f45;
  --red: #b42b2b;
  --amber: #8a5a00;
  --hover: #faf7f0;
  --radius: 10px;
  --shadow: 0 1px 2px rgba(35, 25, 90, 0.07), 0 4px 14px rgba(35, 25, 90, 0.04);
  --serif: Georgia, "Palatino Linotype", Palatino, "Book Antiqua", serif;
  --topbar: 56px;
  --sidebar: 224px;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  font: 14px/1.5 "Segoe UI", system-ui, -apple-system, Roboto, "Helvetica Neue", Arial, sans-serif;
  color: var(--text);
  background: var(--page);
  -webkit-font-smoothing: antialiased;
}
button, input, select, textarea { font: inherit; color: inherit; }
a { color: var(--indigo); text-decoration: none; cursor: pointer; }
a:hover { text-decoration: underline; }
:focus-visible { outline: 2px solid var(--gold-dark); outline-offset: 2px; }
code { font: 12px/1.4 Consolas, "SFMono-Regular", Menlo, monospace; background: var(--indigo-tint); padding: 1px 6px; border-radius: 4px; }
svg { display: block; }
.hidden { display: none !important; }
.muted { color: var(--muted); }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.mono { font-family: Consolas, "SFMono-Regular", Menlo, monospace; font-size: 12px; }
.nowrap { white-space: nowrap; }

/* Top bar */
.topbar {
  position: fixed; inset: 0 0 auto 0; height: var(--topbar); z-index: 20;
  background: linear-gradient(100deg, var(--indigo-deep) 0%, var(--indigo-mid) 60%, #3a2f8f 100%);
  border-bottom: 3px solid var(--gold);
  color: #fff; display: flex; align-items: center; justify-content: space-between; padding: 0 20px; gap: 12px;
}
.brand { display: flex; align-items: center; gap: 12px; min-width: 0; white-space: nowrap; }
.crest { flex: none; width: 32px; height: 32px; display: grid; place-items: center; border-radius: 9px; background: rgba(255, 255, 255, 0.1); color: var(--gold); box-shadow: inset 0 0 0 1px rgba(240, 180, 41, 0.45); }
.brand b { font-family: var(--serif); font-size: 18px; font-weight: 700; letter-spacing: 0.3px; }
.brand .tag { font-size: 11px; font-weight: 700; letter-spacing: 1.4px; text-transform: uppercase; color: var(--indigo-deep); background: var(--gold); padding: 3px 9px; border-radius: 999px; }
.top-right { display: flex; align-items: center; gap: 18px; font-size: 13px; min-width: 0; }
.top-right .env { color: #c4c0ee; }
.top-right .st { color: #f2f0ff; }
.session {
  display: flex; align-items: center; gap: 10px; padding: 4px 12px 4px 4px; height: 40px; border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.2); background: rgba(255, 255, 255, 0.07); color: #fff; cursor: pointer;
}
.session:hover { background: rgba(255, 255, 255, 0.15); }
.avatar { width: 30px; height: 30px; border-radius: 50%; background: var(--gold); color: var(--indigo-deep); display: grid; place-items: center; font-weight: 800; font-size: 13px; flex: none; }
.session small { display: block; color: #c4c0ee; font-size: 11px; line-height: 1.2; text-align: left; white-space: nowrap; }
.session strong { display: block; font-size: 13px; line-height: 1.2; text-align: left; white-space: nowrap; }

/* Sidebar */
.sidebar {
  position: fixed; top: var(--topbar); bottom: 0; left: 0; width: var(--sidebar); background: var(--side);
  border-right: 1px solid var(--line-strong); padding: 16px 10px; overflow-y: auto; z-index: 10;
}
.nav-group + .nav-group { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--line-strong); }
.nav-item {
  position: relative; display: flex; align-items: center; gap: 12px; width: 100%; height: 40px; padding: 0 14px; border: 0; border-radius: 8px;
  background: none; color: #3b3565; text-align: left; font-size: 13px; font-weight: 600; cursor: pointer;
}
.nav-item:hover { background: rgba(67, 56, 176, 0.09); color: var(--indigo-deep); }
.nav-item.active { background: var(--side-active); color: var(--indigo-deep); font-weight: 700; box-shadow: 0 1px 3px rgba(35, 25, 90, 0.14); }
.nav-item.active::before { content: ""; position: absolute; left: -10px; top: 8px; bottom: 8px; width: 4px; border-radius: 0 4px 4px 0; background: var(--gold-dark); }
.nav-item svg { flex: none; stroke: currentColor; }
.nav-item.active svg { stroke: var(--indigo); }
.nav-item .ico { display: inline-flex; flex: none; }
.nav-badge { margin-left: auto; min-width: 20px; height: 18px; padding: 0 6px; border-radius: 9px; background: var(--red); color: #fff; font-size: 11px; font-weight: 700; display: inline-grid; place-items: center; }
.quote { margin: 0; padding: 12px 16px; border-left: 3px solid var(--gold-dark); background: var(--gold-soft); border-radius: 0 var(--radius) var(--radius) 0; overflow-wrap: anywhere; }
.testbox { display: flex; gap: 12px; align-items: flex-end; padding: 16px 24px; border-bottom: 1px solid var(--line); }
.testbox .field { flex: 1 1 auto; }
.testout { padding: 14px 24px; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }

/* Page */
.main { margin: var(--topbar) 0 0 var(--sidebar); padding: 26px 36px 56px; min-height: calc(100vh - var(--topbar)); min-width: 0; }
.page-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 52px; margin-bottom: 20px; flex-wrap: wrap; }
.page-head h1 { margin: 0; font-family: var(--serif); font-size: 29px; font-weight: 700; letter-spacing: -0.2px; color: var(--indigo-deep); overflow-wrap: anywhere; }
.page-head .sub { color: var(--muted); margin-top: 3px; overflow-wrap: anywhere; }
.page-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.crumb { color: var(--muted); font-size: 13px; margin-bottom: 4px; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); min-width: 0; }
.panel .panel { box-shadow: none; }
.panel + .panel, .stack > * + * { margin-top: 18px; }
.grid2 > .panel + .panel, .grid3 > .panel + .panel { margin-top: 0; }
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 24px; border-bottom: 1px solid var(--line); }
.panel-head h2 { margin: 0; font-family: var(--serif); font-size: 16px; font-weight: 700; color: var(--indigo-deep); }
.panel-body { padding: 20px 24px; }
.grid2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
.grid3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; }
.stack { min-width: 0; }

/* Buttons and fields */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 36px; padding: 0 16px;
  border: 1px solid var(--line-strong); border-radius: 8px; background: #fff; color: var(--indigo-deep); font-weight: 600; font-size: 13px; cursor: pointer; white-space: nowrap;
}
.btn:hover { background: var(--indigo-tint); border-color: #b9b2e6; }
.btn:disabled { opacity: 0.5; cursor: default; }
.btn.primary { background: var(--gold); border-color: var(--gold-dark); color: var(--indigo-deep); font-weight: 700; box-shadow: 0 1px 0 rgba(120, 80, 0, 0.25); }
.btn.primary:hover { background: #f5c24a; border-color: var(--gold-dark); }
.btn.danger { background: var(--red); border-color: #8f1f1f; color: #fff; }
.btn.danger:hover { background: #9d2323; }
.btn.text { border-color: transparent; background: none; padding: 0 8px; }
.btn.text:hover { background: var(--indigo-tint); }
.btn.text.red, .btn.red { color: var(--red); }
.btn.text.red:hover { background: #fbe9e8; }
.btn.small { height: 30px; padding: 0 12px; }
.link-btn { background: none; border: 0; padding: 0; color: var(--indigo); font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; gap: 8px; }
.field { display: block; }
.field > span { display: block; font-size: 12px; font-weight: 700; letter-spacing: 0.2px; color: var(--muted); margin-bottom: 6px; }
.field small { display: block; color: var(--muted); font-size: 12px; margin-top: 4px; }
input[type=text], input[type=number], input[type=password], input[type=date], input[type=search], select, textarea {
  width: 100%; height: 38px; border: 1px solid var(--line-strong); border-radius: 8px; background: #fff; padding: 0 12px; outline: none;
}
textarea { height: 96px; padding: 10px 12px; resize: vertical; }
input:focus, select:focus, textarea:focus { border-color: var(--indigo); box-shadow: 0 0 0 3px rgba(240, 180, 41, 0.4); }
.row { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; }
.row > .field { flex: 1 1 140px; }
.form { display: grid; gap: 14px; }
.check { display: flex; align-items: center; gap: 8px; }
.check input { width: 16px; height: 16px; accent-color: var(--indigo); }

/* Tabs, search row, tables */
.tabs { display: flex; gap: 26px; padding: 0 24px; border-bottom: 1px solid var(--line); overflow-x: auto; }
.tab {
  display: inline-flex; align-items: center; gap: 8px; padding: 16px 0 13px; border: 0; background: none; border-bottom: 3px solid transparent;
  color: var(--muted); font-weight: 600; cursor: pointer; white-space: nowrap; margin-bottom: -1px;
}
.tab:hover { color: var(--indigo-deep); }
.tab.active { border-bottom-color: var(--gold-dark); color: var(--indigo-deep); font-weight: 700; }
.badge { min-width: 24px; height: 22px; padding: 0 8px; border-radius: 11px; background: var(--indigo-tint); color: var(--indigo-dark); font-size: 12px; font-weight: 700; display: inline-grid; place-items: center; }
.tab.active .badge { background: var(--indigo); color: #fff; }
.searchrow { display: flex; align-items: center; gap: 14px; height: 64px; padding: 0 24px; border-bottom: 1px solid var(--line); }
.searchrow svg { flex: none; stroke: var(--muted); }
.searchrow input { border: 0; box-shadow: none !important; height: 40px; padding: 0; font-size: 15px; flex: 1; min-width: 0; background: none; }
.filters { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; padding: 16px 24px; border-bottom: 1px solid var(--line); }
.filters .field { flex: 0 1 200px; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th {
  text-align: left; font-size: 12px; font-weight: 700; letter-spacing: 0.6px; text-transform: uppercase; color: var(--muted);
  padding: 13px 12px; border-bottom: 1px solid var(--line-strong); white-space: nowrap; background: #fbf9f4;
}
th:first-child, td:first-child { padding-left: 24px; }
th:last-child, td:last-child { padding-right: 24px; }
th.num { text-align: right; }
th.sortable { cursor: pointer; user-select: none; }
th.sortable:hover { color: var(--indigo-deep); }
th .arrow { display: inline-block; vertical-align: middle; margin-left: 6px; opacity: 0.9; color: var(--indigo); }
td { padding: 14px 12px; border-bottom: 1px solid var(--line); vertical-align: middle; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr.clickable { cursor: pointer; }
tbody tr.clickable:hover td { background: var(--hover); }
tr.totals td { font-size: 16px; font-weight: 700; padding-top: 18px; padding-bottom: 18px; background: var(--gold-soft); }
.delta { display: block; font-size: 12px; font-weight: 400; margin-top: 2px; }
.delta.up { color: var(--green); }
.delta.down { color: var(--red); }
.delta.flat { color: var(--muted); }
.cell-sub { color: var(--muted); font-size: 12px; margin-top: 2px; }
.st { display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; }
.st i { width: 9px; height: 9px; border-radius: 50%; background: #a09cb8; flex: none; }
.st.ok i { background: #2fb458; }
.st.warn i { background: var(--gold); box-shadow: 0 0 0 1px var(--gold-dark); }
.st.bad i { background: var(--red); }
.st.info i { background: var(--indigo); }
.pager { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 24px; border-top: 1px solid var(--line); color: var(--muted); font-size: 13px; flex-wrap: wrap; }
.pager .btns { display: flex; align-items: center; gap: 8px; }
.pager select { width: auto; height: 30px; }
/* Logs */
.chips { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 16px 24px; border-bottom: 1px solid var(--line); }
.chip { display: flex; align-items: center; gap: 10px; height: 34px; padding: 0 14px 0 8px; border: 1px solid var(--line-strong); border-radius: 17px; background: var(--panel); cursor: pointer; }
.chip:hover { background: var(--hover); }
.chip.on { border-color: var(--indigo); background: var(--indigo-tint); }
.chip b { font-variant-numeric: tabular-nums; }
.chip-note { color: var(--muted); font-size: 12px; margin-left: 4px; }
.lvl { display: inline-block; min-width: 52px; text-align: center; padding: 1px 8px; border-radius: 5px; font-size: 12px; font-weight: 700; }
.lvl.error { background: #fbe9e8; color: var(--red); }
.lvl.warn { background: var(--gold-soft); color: var(--amber); }
.lvl.info { background: var(--indigo-tint); color: var(--indigo-dark); }
.lvl.debug { background: #eeeaf0; color: var(--muted); }
.log-row.open td { background: var(--hover); }
.log-msg { overflow-wrap: anywhere; min-width: 280px; }
.log-detail td { background: var(--hover); padding-top: 4px; }
.logpre { margin: 0; padding: 12px 16px; background: #fff; border: 1px solid var(--line); border-radius: 8px; font: 12px/1.5 Consolas, "SFMono-Regular", Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 360px; overflow: auto; }
.state { padding: 56px 24px; text-align: center; color: var(--muted); }
.spinner { width: 24px; height: 24px; border: 3px solid var(--line-strong); border-top-color: var(--gold-dark); border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 12px; }
@keyframes spin { to { transform: rotate(360deg); } }
.banner { padding: 12px 16px; border-radius: 8px; border: 1px solid var(--line); background: var(--hover); }
.banner.warn { border-color: #ecd39a; background: var(--gold-soft); }
.banner.bad { border-color: #efc2c0; background: #fcefee; }
.banner.ok { border-color: #bfe3cb; background: #eef8f1; }

/* Key / value blocks and metrics */
.kv { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 12px 16px; margin: 0; }
.kv dt { color: var(--muted); }
.kv dd { margin: 0; overflow-wrap: anywhere; }
.metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
.metric { padding: 18px 24px; border-right: 1px solid var(--line); border-top: 3px solid var(--gold); }
.metric:last-child { border-right: 0; }
.metric:first-child { border-top-left-radius: var(--radius); }
.metric:last-child { border-top-right-radius: var(--radius); }
.metric span { display: block; color: var(--muted); font-size: 12px; font-weight: 700; letter-spacing: 0.3px; }
.metric strong { display: block; font-size: 24px; font-weight: 700; color: var(--indigo-deep); margin-top: 4px; font-variant-numeric: tabular-nums; }
.metric small { color: var(--muted); }

/* Chart */
.chart-head { display: flex; align-items: center; gap: 16px; padding: 20px 24px 8px; flex-wrap: wrap; }
.pill {
  position: relative; display: inline-flex; align-items: center; gap: 10px; height: 40px; padding: 0 14px 0 16px; border-radius: 20px; background: var(--indigo-tint);
}
.pill i { width: 10px; height: 10px; border-radius: 50%; flex: none; }
.pill select { appearance: none; -webkit-appearance: none; border: 0; background: none; height: 40px; width: auto; padding: 0 22px 0 0; box-shadow: none !important; cursor: pointer; font-weight: 600; color: var(--indigo-deep); }
.pill svg { position: absolute; right: 14px; pointer-events: none; stroke: var(--indigo-dark); }
.chart { position: relative; padding: 4px 24px 18px; }
.chart svg { width: 100%; overflow: visible; }
.chart text { font-size: 11px; fill: #5b5878; font-family: Consolas, "SFMono-Regular", Menlo, monospace; }
.tooltip { position: absolute; pointer-events: none; background: var(--indigo-deep); color: #fff; border-radius: 8px; padding: 10px 12px; font-size: 13px; line-height: 1.5; z-index: 5; white-space: nowrap; box-shadow: 0 6px 18px rgba(20, 15, 70, 0.3); }
.tooltip b { display: block; color: var(--gold); }

/* Dialog, toasts, lookup */
.backdrop { position: fixed; inset: 0; background: rgba(20, 16, 66, 0.55); z-index: 50; display: grid; place-items: center; padding: 16px; }
.modal { background: #fff; border-radius: 14px; border-top: 4px solid var(--gold); width: min(520px, 100%); max-height: calc(100vh - 32px); overflow: auto; box-shadow: 0 20px 60px rgba(20, 15, 70, 0.4); }
.modal.wide { width: min(720px, 100%); }
.modal h3 { margin: 0; padding: 20px 24px 0; font-family: var(--serif); font-size: 20px; color: var(--indigo-deep); }
.modal .body { padding: 14px 24px 8px; }
.modal .foot { display: flex; justify-content: flex-end; gap: 8px; padding: 16px 24px 20px; }
.toasts { position: fixed; top: calc(var(--topbar) + 14px); right: 20px; z-index: 60; display: grid; gap: 8px; width: min(380px, calc(100vw - 40px)); }
.toast { background: var(--indigo-deep); color: #fff; padding: 12px 16px; border-radius: 8px; border-left: 4px solid #a09cb8; box-shadow: 0 8px 24px rgba(20, 15, 70, 0.35); }
.toast.ok { border-left-color: #3ecb6a; }
.toast.bad { border-left-color: #ff6b66; }
.toast.warn { border-left-color: var(--gold); }
.lookup { position: relative; }
.lookup-list { position: absolute; left: 0; right: 0; top: 100%; z-index: 10; background: #fff; border: 1px solid var(--line-strong); border-radius: 8px; margin-top: 4px; max-height: 260px; overflow: auto; box-shadow: var(--shadow); }
.lookup-list button { display: block; width: 100%; text-align: left; padding: 10px 12px; border: 0; background: none; cursor: pointer; border-bottom: 1px solid var(--line); }
.lookup-list button:last-child { border-bottom: 0; }
.lookup-list button:hover { background: var(--indigo-tint); }
.menu { position: absolute; right: 0; top: 100%; z-index: 15; background: #fff; border: 1px solid var(--line-strong); border-radius: 8px; padding: 8px 12px; min-width: 190px; box-shadow: var(--shadow); }
.menu label { display: flex; align-items: center; gap: 8px; padding: 6px 0; }
.rel { position: relative; }
.activity-item { padding: 12px 24px; border-bottom: 1px solid var(--line); }
.activity-item:last-child { border-bottom: 0; }

@media (max-width: 960px) {
  :root { --sidebar: 60px; }
  .nav-item { justify-content: center; padding: 0; }
  .nav-item span:not(.ico):not(.nav-badge) { display: none; }
  .nav-item .nav-badge { position: absolute; top: 2px; right: 2px; margin: 0; min-width: 16px; height: 16px; padding: 0 4px; font-size: 10px; }
  .nav-item.active::before { left: -10px; }
  .main { padding: 20px 18px 40px; }
  .grid2, .grid3 { grid-template-columns: minmax(0, 1fr); }
  .session small, .top-right .env { display: none; }
  .page-head h1 { font-size: 24px; }
}
@media (max-width: 640px) {
  .topbar { padding: 0 12px; }
  .brand b { font-size: 16px; }
  .brand .tag, .session > span:last-child { display: none; }
  .session { padding: 4px; }
  .top-right { gap: 10px; }
  .top-right .st { font-size: 12px; }
  .main { padding: 16px 12px 40px; }
  .page-head { align-items: flex-start; }
  .page-actions { justify-content: flex-start; }
  .panel-head, .panel-body, .metric, .chart-head, .searchrow, .filters, .chips, .testbox, .testout, .pager, .activity-item { padding-left: 16px; padding-right: 16px; }
  .tabs { padding: 0 16px; gap: 20px; }
  th:first-child, td:first-child { padding-left: 16px; }
  th:last-child, td:last-child { padding-right: 16px; }
  .kv { grid-template-columns: minmax(0, 1fr); gap: 2px; }
  .kv dd { margin-bottom: 10px; }
  .testbox { flex-wrap: wrap; }
  .modal h3, .modal .body, .modal .foot { padding-left: 16px; padding-right: 16px; }
  .chart { padding-left: 12px; padding-right: 12px; }
}
`;
