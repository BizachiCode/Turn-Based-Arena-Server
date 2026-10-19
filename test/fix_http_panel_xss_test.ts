import assert from "node:assert/strict";

import { renderGmPanelPage, gmPanelCsp } from "../src/modules/admin/gm-panel.page";
import { ANSWERS, GUILD, USER, boot, flush, type Answers } from "./support/gm-panel-dom";

// Stored XSS in the GM panel. Every free-text field the server can hand to the panel (nicknames, usernames, guild texts,
// chat lines, report comments, mail titles, log messages, reasons, device ids...) is replaced by a payload that breaks out
// of text and of attribute values, then every view and dialog is rendered on the DOM stub. No markup string the panel
// writes may contain the payload unescaped. (tools/pentest/admin-xss.mjs repeats this in a real browser.)

const PAYLOAD = "\"'><svg/onload=PWN7>";
const ESCAPED = "&quot;&#39;&gt;&lt;svg/onload=PWN7&gt;";

/** Keys that carry text written by players, operators or the server's own error messages. */
const TEXT_KEYS = new Set([
  "name", "nickname", "username", "email", "guild", "guildName", "leaderName", "description", "notice", "comment", "message", "messageText", "text", "title", "sender", "reason", "note",
  "deviceId", "userAgent", "ip", "scope", "details", "room", "output", "input", "lastStoreError", "hostname", "platform", "nodeVersion", "roomId", "processId", "kind", "characterId",
  "setId", "dialogueId", "regionId", "seasonKey", "mainStatType", "iconId", "tags", "dialogues", "currencies", "id", "mode", "file", "version", "maskChar", "category", "source",
  "difficulty", "location", "role", "joinType", "level", "resolutionAction", "resolutionNote", "status", "sourceRef", "ref",
]);

/** Keys whose value the panel parses as a date / number / route: left alone so the views still render. */
const KEEP = /(At|Unix|Date|Time|time|since|dates?|^ok$|userId|guildId|^uid$|publicId|memberId|reportId|deviceId$)/;

function poison(value: unknown, key = "", all = false): unknown {
  if (typeof value === "string") {
    if (KEEP.test(key) && !TEXT_KEYS.has(key)) return value;
    return all || TEXT_KEYS.has(key) ? PAYLOAD : value;
  }
  if (Array.isArray(value)) return value.map((item) => (typeof item === "string" && (all || TEXT_KEYS.has(key)) ? PAYLOAD : poison(item, key, all)));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, k === "ok" ? v : poison(v, k, all)]));
  }
  return value;
}

function poisoned(all: boolean): Answers {
  return ANSWERS.map(([pattern, answer]) => [pattern, poison(answer, "", all)] as [RegExp, unknown]);
}

const VIEWS = [
  "#overview", "#runtime", "#rooms", "#players", "#guilds", "#chat", "#reports", "#mail", "#audit", "#logs", "#config", "#grants",
  `#players/${USER}`, ...["wallet", "monsters", "runes", "progress", "story", "connections", "reports", "audit"].map((tab) => `#players/${USER}/${tab}`),
  `#guilds/${GUILD}`, "#reports/5",
];

const CLICKS: Array<[string, Record<string, string>]> = [
  ["chatScope", { "data-tab": "guild" }], ["chatScope", { "data-tab": "filter" }], ["chatScope", { "data-tab": "global" }],
  ["mailTab", { "data-tab": "broadcasts" }], ["mailTab", { "data-tab": "direct" }], ["lgToggle", { "data-id": "9" }], ["lgLevel", { "data-level": "error" }],
  ["fiTest", {}],
];

/** Dialogs prefilled with data (rename, edits, confirmations that name the player / guild / unit). */
const DIALOGS: Array<[string, string, Record<string, string>]> = [
  [`#players/${USER}`, "pRename", {}], [`#players/${USER}`, "pMail", {}], [`#players/${USER}`, "pKick", {}], [`#players/${USER}`, "pBan", {}], [`#players/${USER}`, "pMute", {}],
  [`#players/${USER}`, "pLevel", {}], [`#players/${USER}`, "pGuildRemove", {}], [`#players/${USER}`, "pRevoke", {}],
  [`#players/${USER}/wallet`, "pSetCurrency", { "data-id": "GO" }], [`#players/${USER}/wallet`, "pGrantCurrency", {}],
  [`#players/${USER}/monsters`, "pUnitEdit", { "data-uid": "u1" }], [`#players/${USER}/monsters`, "pUnitDelete", { "data-uid": "u1" }],
  [`#players/${USER}/runes`, "pRuneDelete", { "data-uid": "r1" }],
  [`#guilds/${GUILD}`, "gEdit", {}], [`#guilds/${GUILD}`, "gDisband", {}], [`#guilds/${GUILD}`, "gLeader", { "data-id": USER }], [`#guilds/${GUILD}`, "gKick", { "data-id": USER }],
  ["#reports/5", "rpResolve", {}], ["#reports/5", "rpDismiss", {}], ["#reports/5", "rpResolveAll", {}], ["#reports/5", "rpDismissAll", {}],
  ["#chat", "chMute", { "data-id": "9" }], ["#chat", "chDelete", { "data-id": "9" }], ["#mail", "mailRevoke", { "data-id": "b1" }],
];

async function renderEverything(answers: Answers): Promise<string[]> {
  const panel = boot(answers);
  await flush();
  const attempt = async (fn: () => Promise<unknown>) => { try { await fn(); } catch { /* a view that cannot cope with odd data is not an injection */ } };
  for (const view of VIEWS) {
    await attempt(() => panel.goto(view));
    if (view === "#chat" || view === "#mail" || view === "#logs") for (const [act, attrs] of CLICKS) await attempt(() => panel.clickAct(act, attrs));
  }
  for (const [view, act, attrs] of DIALOGS) {
    await attempt(() => panel.goto(view));
    await attempt(() => panel.clickAct(act, attrs));
  }
  return panel.document.writes;
}

function assertNoInjection(writes: string[], label: string) {
  assert.ok(writes.length > 100, `${label}: the panel wrote ${writes.length} markup strings`);
  for (const html of writes) {
    assert.equal(html.includes("<svg/onload"), false, `${label}: raw tag from a payload in ${html.slice(0, 200)}`);
    assert.equal(html.includes("\"'>"), false, `${label}: attribute / tag break-out sequence in ${html.slice(0, 200)}`);
    assert.equal(/\son[a-z]+=PWN7/.test(html), false, `${label}: event handler attribute from a payload`);
  }
}

describe("GM panel: stored XSS (DOM stub)", () => {
  it("escapes every free-text field of every view and dialog", async () => {
    const writes = await renderEverything(poisoned(false));
    assertNoInjection(writes, "text fields");
    const escaped = writes.filter((html) => html.includes(ESCAPED)).length;
    assert.ok(escaped >= 40, `the payload must actually reach the markup (escaped) in many places, found ${escaped}`);
  });

  it("escapes even when every string the server sends is hostile", async () => {
    const writes = await renderEverything(poisoned(true));
    assertNoInjection(writes, "all strings");
  });

  it("the unpoisoned control renders without the payload (the check is not vacuous)", async () => {
    const writes = await renderEverything(ANSWERS);
    assert.equal(writes.some((html) => html.includes(ESCAPED)), false);
  });

  it("a missing escape would be caught: the same walk sees a raw payload in a deliberately broken write", () => {
    const broken = [`<td>${PAYLOAD}</td>`];
    assert.throws(() => assertNoInjection([...broken, ...Array.from({ length: 120 }, () => "<p>x</p>")], "control"), /raw tag|break-out/);
  });
});

describe("GM panel page: CSP-ready markup", () => {
  const page = renderGmPanelPage("TESTNONCE123456==");

  it("has one inline script with the nonce and no inline event handlers, remote code or javascript: URLs", () => {
    assert.equal(page.match(/<script\b/g)?.length, 1);
    assert.ok(page.includes('<script nonce="TESTNONCE123456==">'));
    const markup = page.replace(/<script[\s\S]*<\/script>/, "").replace(/<style[\s\S]*<\/style>/, "");
    assert.doesNotMatch(markup, /\son[a-z]+\s*=/i);
    assert.doesNotMatch(markup, /javascript:/i);
    assert.doesNotMatch(page, /(src|href|action)\s*=\s*["']\s*(https?:)?\/\//i);
  });

  it("the client script never uses eval-like APIs, document.write or HTML-inserting shortcuts", () => {
    const script = page.match(/<script[^>]*>([\s\S]*)<\/script>/)![1]!;
    assert.doesNotMatch(script, /\beval\s*\(|new\s+Function\s*\(|document\.write|insertAdjacentHTML|outerHTML\s*=|setTimeout\s*\(\s*["']|setInterval\s*\(\s*["']/);
    assert.doesNotMatch(script, /location\.(search|href)\s*=|window\.open\s*\(/);
  });

  it("builds a CSP that only allows the nonce script, same-origin requests and no framing", () => {
    const csp = gmPanelCsp("abc");
    assert.match(csp, /script-src 'nonce-abc'/);
    assert.doesNotMatch(csp, /script-src[^;]*unsafe/);
    for (const directive of ["default-src 'none'", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "object-src 'none'", "form-action 'none'"]) assert.ok(csp.includes(directive), directive);
  });
});
