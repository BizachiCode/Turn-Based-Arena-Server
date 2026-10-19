// DOM stub and canned API answers to run the GM panel script without a browser (see gm_panel_runtime_test.ts).
import { renderGmPanelPage } from "../../src/modules/admin/gm-panel.page";

// Runs the panel script against a tiny DOM stub and canned API answers, then drives every view through the router.
// It catches what the syntax test cannot: undefined helpers, wrong element ids and exceptions while rendering real
// response shapes. Layout and styling are not covered (no browser here).

export type Listener = (event: unknown) => void;

export class FakeEl {
  attrs: Record<string, string> = {};
  style: Record<string, string> = {};
  classes = new Set<string>();
  value = "";
  checked = false;
  clientWidth = 1000;
  private html = "";
  textContent = "";
  constructor(private readonly doc: FakeDocument, public id = "") {}
  get innerHTML() { return this.html; }
  set innerHTML(value: string) {
    this.html = String(value);
    this.doc.register(this.html);
  }
  get dataset() {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.attrs)) {
      if (key.startsWith("data-")) out[key.slice(5).replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())] = value;
    }
    return out;
  }
  get classList() {
    return {
      add: (name: string) => { this.classes.add(name); },
      remove: (name: string) => { this.classes.delete(name); },
      toggle: (name: string, force?: boolean) => { if (force === undefined ? !this.classes.has(name) : force) this.classes.add(name); else this.classes.delete(name); },
      contains: (name: string) => this.classes.has(name),
    };
  }
  get parentNode() { return { classList: { add: () => undefined }, removeChild: () => undefined }; }
  getAttribute(name: string) { return this.attrs[name] ?? null; }
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
  hasAttribute(name: string) { return name in this.attrs; }
  closest(selector: string) { return /^\[data-act\]$/.test(selector) && "data-act" in this.attrs ? this : null; }
  /** Same selector, same element, so a test can reach the form a dialog just created and fire its listeners. */
  private found = new Map<string, FakeEl>();
  listeners: Record<string, Listener[]> = {};
  querySelector(selector: string) {
    if (!this.found.has(selector)) this.found.set(selector, new FakeEl(this.doc));
    return this.found.get(selector)!;
  }
  querySelectorAll() { return []; }
  appendChild() { return undefined; }
  addEventListener(type: string, fn: Listener) { (this.listeners[type] ??= []).push(fn); }
  focus() { return undefined; }
  setSelectionRange() { return undefined; }
  getBoundingClientRect() { return { left: 0, width: 1000 }; }
}

export class FakeDocument {
  /** Every markup string the script assigned to an element (`innerHTML`), in order. */
  writes: string[] = [];
  els = new Map<string, FakeEl>();
  listeners: Record<string, Listener[]> = {};
  /** Elements whose markup is written by the script get an entry per `id="..."` found in it. */
  register(html: string) {
    this.writes.push(html);
    for (const match of html.matchAll(/\bid="([A-Za-z0-9_]+)"/g)) {
      if (!this.els.has(match[1]) || true) this.els.set(match[1], new FakeEl(this, match[1]));
    }
  }
  getElementById(id: string) { return this.els.get(id) ?? null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  createElement() { return new FakeEl(this); }
  addEventListener(type: string, fn: Listener) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener() { return undefined; }
  fire(type: string, event: unknown) { for (const fn of this.listeners[type] ?? []) fn(event); }
}

export const USER = "11111111-2222-3333-4444-555555555555";
export const GUILD = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
export const EVIL = "<img src=x onerror=alert(1)>";

export type Answers = Array<[RegExp, unknown]>;
export const ANSWERS: Answers = [
  [/\/status$/, { ok: true, reports: { open: 2 }, snapshot: {
    serverTime: "2026-10-15T12:00:00Z", uptimeSec: 4000, maintenance: { enabled: false, message: null, startedAt: null, updatedAt: "2026-10-15T11:00:00Z" },
    totals: { rooms: 2, clients: 3 }, host: { hostname: "h", platform: "win32", processId: 1, nodeVersion: "v22", cpuCount: 8, totalMemMb: 16000, freeMemMb: 8000, usedMemPercent: 50, rssMb: 200, heapUsedMb: 100, loadAvg1m: 0.1, loadAvg5m: 0, loadAvg15m: 0 },
    telemetry: { current: {}, history: [{ at: "2026-10-15T11:58:00Z", rooms: 1, clients: 1, rssMb: 100, heapUsedMb: 50 }, { at: "2026-10-15T11:59:00Z", rooms: 2, clients: 3, rssMb: 110, heapUsedMb: 60 }] },
    rooms: [{ roomId: "r1", name: "presence", clients: 3, maxClients: 100, locked: false, private: false, processId: "p1", createdAt: "2026-10-15T11:00:00Z" }],
    lastDisconnect: null, recentActivity: [{ at: "2026-10-15T11:00:00Z", kind: "boot", message: "Server runtime controls initialized." }],
  } }],
  [/catalog\/summary$/, { ok: true, currencies: [{ id: "GO", hasCap: false, rechargeable: false }], characters: [{ id: "hero", element: "Fire", naturalStars: 3 }], runeSets: [{ id: "Fatal", name: "Fatal" }], dialogues: ["tutorial_1"] }],
  [/analytics\?days=7$/, { ok: true, analytics: {
    days: 7, dates: Array.from({ length: 7 }, (_v, i) => `2026-10-${String(9 + i).padStart(2, "0")}`), shopSpentCurrency: "GO", totalAccounts: 12,
    series: Object.fromEntries(["newAccounts", "activePlayers", "logins", "pveBattles", "arenaBattles", "mailDelivered", "shopPurchases", "gmCurrencyGranted", "battles", "shopSpent"].map((k) => [k, [0, 1, 2, 3, 4, 5, 6]])),
    totals: Object.fromEntries(["newAccounts", "activePlayers", "logins", "pveBattles", "arenaBattles", "mailDelivered", "shopPurchases", "gmCurrencyGranted", "battles", "shopSpent"].map((k, i) => [k, { value: 21, previous: 21 + (i % 3) - 1, delta: 1 - (i % 3) }])),
  } }],
  [/\/players\?/, { ok: true, total: 1, page: 1, pageSize: 25, counts: { all: 12, online: 1, banned: 0, muted: 0, guests: 11, deletion: 0, reported: 2 },
    rows: [{ userId: USER, username: "alice", name: EVIL, email: "a@x.io", level: 12, guild: "Knights", lastLoginAt: "2026-10-15T10:00:00Z", createdAt: "2026-10-01T10:00:00Z", online: true, banned: false, muted: false, isGuest: false, deletionScheduledAt: null }] }],
  [/\/players\/[^/?]+\/audit/, { ok: true, entries: [{ id: 5, kind: "LOGIN", meta: { ip: "1.2.3.4" }, createdAt: "2026-10-15T10:00:00Z" }] }],
  [/\/players\/[^/?]+$/, { ok: true, player: {
    account: { userId: USER, username: "alice", email: "a@x.io", isGuest: false, createdAt: "2026-10-01T10:00:00Z", lastLoginAt: "2026-10-15T10:00:00Z", failedLogins: 0, lockedUntil: null, ban: { active: true, reason: EVIL, until: null }, chatMute: null, deletionScheduledAt: null },
    profile: { name: EVIL, iconId: "icon_1", level: 12, currentExp: 40 }, wallet: { GO: 1000 },
    roster: { bagCapacity: 50, storageCapacity: 50, units: [{ uid: "u1", characterId: "hero", stars: 3, level: 10, awakeningIndex: 0, location: "BAG", locked: false, runes: 1, createdAt: "2026-10-01T10:00:00Z" }] },
    runes: { capacity: 100, total: 1, items: [{ uid: "r1", setId: "Fatal", slot: 2, tier: 6, quality: 5, level: 3, mainStatType: "ATK", mainStatValue: 12, equippedToUid: "u1" }] },
    stages: [{ regionId: "forest", difficulty: "Normal", cleared: 3, clears: 10 }], towers: [{ regionId: "tower", seasonKey: "S1", clearedFloors: 4 }],
    story: { completed: [{ dialogueId: "tutorial_1", skipped: false, times: 1, completedAt: "2026-10-02T10:00:00Z" }], active: null },
    guild: { guildId: GUILD, name: "Knights", role: "leader", joinedAt: "2026-10-03T10:00:00Z" },
    arena: { rating: 1200, wins: 3, losses: 1, defenseWins: 0, defenseLosses: 0, season: 1, seasonBattles: 4 },
    connections: [{ deviceId: "d1", room: "presence", connectedAt: "2026-10-15T10:00:00Z", lastHeartbeatAt: "2026-10-15T11:59:00Z", ip: "1.2.3.4", userAgent: "UnityPlayer" }],
  } }],
  [/\/guilds\/[^/?]+$/, { ok: true, detail: {
    guild: { guildId: GUILD, name: EVIL, memberCount: 2, leaderName: "alice", leaderUserId: USER, joinType: "open", minLevel: 1, activityPoints: 60, createdAt: "2026-10-03T10:00:00Z", description: EVIL, notice: "", iconId: "emblem", tags: ["casual"] },
    members: [{ userId: USER, publicId: "p1", name: "alice", level: 12, role: "leader", joinedAt: "2026-10-03T10:00:00Z", lastLoginAt: null }, { userId: "u2", publicId: "p2", name: "bob", level: 5, role: "member", joinedAt: "2026-10-04T10:00:00Z", lastLoginAt: "2026-10-15T10:00:00Z" }],
    pendingRequests: 1 } }],
  [/\/guilds\?/, { ok: true, total: 1, page: 1, pageSize: 100, counts: { all: 1, open: 1, approval: 0 }, rows: [{ guildId: GUILD, name: EVIL, memberCount: 2, leaderName: "alice", leaderUserId: USER, joinType: "open", minLevel: 1, activityPoints: 60, createdAt: "2026-10-03T10:00:00Z" }] }],
  [/chat\/filter\/test\?/, { ok: true, result: { enabled: true, mode: "mask", matched: true, blocked: false, input: "a shit", output: `a ****${EVIL}` } }],
  [/chat\/filter$/, { ok: true,
    filter: { enabled: true, mode: "mask", wholeWordOnly: true, maskChar: "*", words: 120, allowList: 4 },
    stats: { sinceUnix: 1_790_000_000, masked: 5, blocked: 1, players: [{ userId: USER, username: EVIL, masked: 4, blocked: 1, lastAtUnix: 1_790_000_100 }] } }],
  [/\/reports\?/, { ok: true, total: 1, page: 1, pageSize: 25, counts: { open: 2, resolved: 3, dismissed: 1, all: 6 }, rows: [{
    id: 5, status: "open", category: "offensive", source: "global_chat", comment: EVIL, reporter: { userId: "u-rep", username: "rep_acct", name: EVIL },
    target: { userId: USER, username: "alice", name: EVIL }, openAgainstTarget: 2, createdAt: "2026-10-15T10:00:00Z", handledAt: null, resolutionAction: null }] }],
  [/\/reports\/\d+$/, { ok: true, detail: {
    report: { id: 5, status: "open", category: "offensive", source: "global_chat", comment: EVIL, reporter: { userId: "u-rep", username: "rep_acct", name: "Rep" },
      target: { userId: USER, username: "alice", name: EVIL }, openAgainstTarget: 2, createdAt: "2026-10-15T10:00:00Z", handledAt: null, resolutionAction: null,
      sourceRef: "0", messageId: 9, messageText: EVIL, context: [{ source: "global", id: 9, ref: "0", text: EVIL, at: "2026-10-15T09:59:00Z" }], resolutionNote: null },
    target: { userId: USER, username: "alice", name: EVIL, level: 12, banned: false, muted: true },
    related: [{ id: 4, status: "resolved", category: "spam", source: "profile", comment: "", reporter: { userId: "u2", username: "bob_acct", name: "Bob" },
      target: { userId: USER, username: "alice", name: "Alice" }, openAgainstTarget: 2, createdAt: "2026-10-10T10:00:00Z", handledAt: "2026-10-11T10:00:00Z", resolutionAction: "mute" }],
    sanctions: [{ id: 3, kind: "GM_MUTE", meta: { reason: EVIL }, createdAt: "2026-10-11T10:00:00Z" }] } }],
  [/chat\/channels$/,{ ok: true, channels: [{ channel: 0, messages: 4, lastAt: "2026-10-09T07:40:18Z" }] }],
  [/chat\/messages\?/, { ok: true, messages: [{ id: 9, scope: "global", channel: 0, guildId: null, guildName: null, userId: USER, nickname: "alice", level: 12, message: EVIL, system: false, createdAt: "2026-10-15T10:00:00Z" }] }],
  [/mail\/history\?/, { ok: true,
    broadcasts: [{ id: "b1", title: EVIL, sender: "GM", hasRewards: true, includeNewPlayers: false, recipients: 5, createdAt: "2026-10-15T10:00:00Z", expiresAt: null, active: true }],
    direct: [{ auditId: 7, userId: USER, username: "alice", title: "Sorry", reason: null, createdAt: "2026-10-15T10:00:00Z" }] }],
  [/audit\/kinds$/, { ok: true, kinds: ["LOGIN", "BAN"] }],
  [/\/audit\?/, { ok: true, entries: [{ id: 3, kind: "BAN", userId: USER, username: "alice", meta: { reason: EVIL }, createdAt: "2026-10-15T10:00:00Z" }] }],
  [/logs\/summary$/, { ok: true, summary: { since: "2026-10-14T12:00:00Z", counts: { debug: 0, info: 40, warn: 3, error: 2 }, source: "database", retentionDays: 14,
    scopes: [{ scope: "RuntimeAdmin", count: 30 }, { scope: EVIL, count: 2 }], sink: { buffered: 10, capacity: 2000, pending: 1, persisted: 40, dropped: 0, storeAttached: true, storeHealthy: true, lastStoreError: null, consoleMode: "none", minLevel: "info" } } }],
  [/\/logs\?/, { ok: true, source: "database", nextBefore: 7, entries: [
    { id: 9, time: "2026-10-15T10:00:05Z", level: "error", scope: "SummonRoom", message: EVIL, details: "Error: boom\n    at " + EVIL, userId: USER, room: "summon", repeats: 3, pid: 100 },
    { id: 8, time: "2026-10-15T10:00:01Z", level: "info", scope: "Bootstrap", message: "Redis ready", details: null, userId: null, room: null, repeats: 1, pid: 100 }] }],
  [/config\/files$/, { ok: true, files: [{ file: "arena.json", updatedAt: "2026-10-15T10:00:00Z", bytes: 2048, version: "1.0", counts: { seasons: 6 }, snapshotAt: null }] }],
];

export async function flush() {
  for (let i = 0; i < 25; i++) await new Promise((resolve) => setImmediate(resolve));
}

export function boot(answers: Answers = ANSWERS) {
  const document = new FakeDocument();
  for (const id of ["content", "modalRoot", "toasts", "topStatus", "topStatusText", "envLabel", "sessionAvatar", "sessionName", "sessionSub", "dlCurrencies", "dlCharacters", "dlRuneSets", "navReportsBadge"]) {
    document.els.set(id, new FakeEl(document, id));
  }
  const storage = new Map<string, string>([["tba_gm_api_key", "test-key"]]);
  const windowStub = {
    location: { hash: "#overview", host: "localhost:2567" },
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    addEventListener: (type: string, fn: Listener) => { document.addEventListener(`window:${type}`, fn); },
    setInterval: () => 1,
    clearInterval: () => undefined,
    setTimeout: (fn: () => void) => { void fn; return 1; },
    clearTimeout: () => undefined,
    scrollTo: () => undefined,
  };
  const requests: string[] = [];
  const fetchStub = async (url: string, init?: { method?: string }) => {
    requests.push(`${init?.method ?? "GET"} ${url}`);
    const hit = answers.find(([pattern]) => pattern.test(url));
    const body = hit ? hit[1] : { ok: false, error: "NOT_MOCKED", detail: url };
    return { status: hit ? 200 : 404, ok: !!hit, text: async () => JSON.stringify(body) };
  };
  const script = renderGmPanelPage().match(/<script>([\s\S]*)<\/script>/)![1];
  const run = new Function("window", "document", "fetch", "navigator", "Event", script);
  run(windowStub, document, fetchStub, {}, class { constructor(public type: string) {} });
  const goto = async (hash: string) => {
    windowStub.location.hash = hash;
    document.fire("window:hashchange", {});
    await flush();
  };
  /** Confirms the dialog the last action opened (plain confirmations only: there are no field elements). */
  const confirmDialog = async () => {
    const form = document.els.get("modalRoot")!.querySelector("form");
    for (const fn of form.listeners.submit ?? []) fn({ preventDefault: () => undefined });
    await flush();
  };
  return { document, goto, requests, confirmDialog, content: () => document.els.get("content")!.innerHTML, clickAct: async (act: string, attrs: Record<string, string> = {}) => {
    const target = new FakeEl(document);
    target.attrs = { "data-act": act, ...attrs };
    document.fire("click", { target, preventDefault: () => undefined });
    await flush();
  } };
}
