// GM panel HTML shell: top bar, sidebar navigation and the containers the client script renders into.

/** `badge`: id of a count pill the client fills (the Reports item shows the open reports). */
type NavItem = { view: string; label: string; icon: string; badge?: string };

/** Sidebar groups; the client script owns the icons (inline SVG) and fills the `data-icon` placeholders. */
const NAV_GROUPS: NavItem[][] = [
  [
    { view: "overview", label: "Overview", icon: "overview" },
    { view: "runtime", label: "Runtime", icon: "runtime" },
    { view: "rooms", label: "Rooms & activity", icon: "rooms" },
  ],
  [
    { view: "players", label: "Players", icon: "players" },
    { view: "guilds", label: "Guilds", icon: "guilds" },
    { view: "chat", label: "Chat", icon: "chat" },
    { view: "reports", label: "Reports", icon: "reports", badge: "navReportsBadge" },
  ],
  [
    { view: "grants", label: "Grants", icon: "grants" },
    { view: "mail", label: "Mail", icon: "mail" },
  ],
  [
    { view: "audit", label: "Audit log", icon: "audit" },
    { view: "logs", label: "Logs", icon: "logs" },
    { view: "config", label: "Config", icon: "config" },
  ],
];

export function renderGmShell(): string {
  const nav = NAV_GROUPS.map((group) =>
    `<div class="nav-group">${group.map((item) =>
      `<button type="button" class="nav-item" data-act="nav" data-view="${item.view}" title="${item.label}"><span class="ico" data-icon="${item.icon}"></span><span>${item.label}</span>${item.badge ? `<span class="nav-badge hidden" id="${item.badge}"></span>` : ""}</button>`,
    ).join("")}</div>`).join("");

  return `<header class="topbar">
    <div class="brand"><span class="crest" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l8 3v6c0 5-3.4 8.7-8 11-4.6-2.3-8-6-8-11V5l8-3z" fill-opacity="0.25" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M12 7l1.4 3.2 3.4.3-2.6 2.2.8 3.3L12 14.2 9 16l.8-3.3-2.6-2.2 3.4-.3L12 7z"/></svg></span><b>Turn-Based Arena</b><span class="tag">GM Console</span></div>
    <div class="top-right">
      <span class="env" id="envLabel"></span>
      <span class="st" id="topStatus"><i></i><span id="topStatusText">Status unknown</span></span>
      <button type="button" class="session" data-act="session">
        <span class="avatar" id="sessionAvatar">?</span>
        <span><strong id="sessionName">No session</strong><small id="sessionSub">Set the admin key</small></span>
      </button>
    </div>
  </header>
  <nav class="sidebar" aria-label="Sections">${nav}</nav>
  <main class="main" id="content"></main>
  <div id="modalRoot"></div>
  <div class="toasts" id="toasts" aria-live="polite"></div>
  <datalist id="dlCurrencies"></datalist>
  <datalist id="dlCharacters"></datalist>
  <datalist id="dlRuneSets"></datalist>`;
}
