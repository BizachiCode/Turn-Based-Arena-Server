import assert from "node:assert/strict";

import { ANSWERS, EVIL, GUILD, USER, boot, flush } from "./support/gm-panel-dom";

// Runs the panel script against a tiny DOM stub and canned API answers, then drives every view through the router.
// It catches what the syntax test cannot: undefined helpers, wrong element ids and exceptions while rendering real
// response shapes. Layout and styling are not covered (no browser here).

describe("GM panel runtime (DOM stub)", () => {
  it("renders the overview with chart, totals and live status", async () => {
    const panel = boot();
    await flush();
    const html = panel.content();
    assert.match(html, /<h1>Overview<\/h1>/);
    assert.match(panel.document.els.get("ovChart")!.innerHTML, /New accounts/);
    assert.match(panel.document.els.get("ovTable")!.innerHTML, /class="totals"/);
    assert.match(panel.document.els.get("ovChartBox")!.innerHTML, /<svg/);
    assert.match(panel.document.els.get("ovLive")!.innerHTML, /Online connections/);
    assert.ok(panel.requests.some((r) => r.includes("/analytics?days=7")));
    assert.equal(panel.document.els.get("topStatusText")!.textContent, "Online - 3 connections");
  });

  it("renders the players list with tabs, escaped names and links", async () => {
    const panel = boot();
    await panel.goto("#players");
    const table = panel.document.els.get("plTable")!.innerHTML;
    assert.match(table, /alice/);
    assert.equal(table.includes(EVIL), false, "player text must be escaped");
    assert.match(table, /&lt;img src=x/);
    assert.match(panel.document.els.get("plTabs")!.innerHTML, /Online<span class="badge">1<\/span>/);
    assert.match(table, /data-to="#players\/11111111/);
  });

  it("renders every player tab from the detail answer", async () => {
    const panel = boot();
    await panel.goto(`#players/${USER}`);
    assert.match(panel.content(), /Send mail/);
    assert.equal(panel.content().includes(EVIL), false);
    for (const [tab, expected] of [["wallet", /Grant currency/], ["monsters", /Grant monster/], ["runes", /Grant rune/], ["progress", /Stages cleared/], ["story", /Reset story/], ["connections", /UnityPlayer/]] as const) {
      await panel.goto(`#players/${USER}/${tab}`);
      assert.match(panel.document.els.get("pBody")!.innerHTML, expected, `tab ${tab}`);
    }
    await panel.goto(`#players/${USER}/audit`);
    assert.match(panel.document.els.get("pAudit")!.innerHTML, /LOGIN/);
  });

  it("renders guilds (list and detail), chat, mail history, audit and config", async () => {
    const panel = boot();
    await panel.goto("#guilds");
    assert.match(panel.document.els.get("guTable")!.innerHTML, /Quest|&lt;img/);
    await panel.goto(`#guilds/${GUILD}`);
    assert.match(panel.content(), /Make leader/);
    assert.equal(panel.content().includes(EVIL), false);

    await panel.goto("#chat");
    assert.match(panel.document.els.get("chTable")!.innerHTML, /&lt;img src=x/);
    await panel.clickAct("chatScope", { "data-tab": "guild" });
    assert.match(panel.content(), /Guild chat/);

    await panel.goto("#mail");
    await panel.clickAct("mailTab", { "data-tab": "broadcasts" });
    assert.match(panel.document.els.get("mlBody")!.innerHTML, /Revoke/);
    await panel.clickAct("mailTab", { "data-tab": "direct" });
    assert.match(panel.document.els.get("mlBody")!.innerHTML, /Sorry/);

    await panel.goto("#audit");
    assert.match(panel.document.els.get("auTable")!.innerHTML, /BAN/);
    assert.equal(panel.document.els.get("auTable")!.innerHTML.includes(EVIL), false);

    await panel.goto("#config");
    assert.match(panel.document.els.get("cfBody")!.innerHTML, /arena\.json/);
  });

  it("shows the open reports badge, the queue, the detail and the player tab with escaped text", async () => {
    const panel = boot();
    await flush();
    assert.equal(panel.document.els.get("navReportsBadge")!.textContent, "2");
    assert.equal(panel.document.els.get("navReportsBadge")!.classes.has("hidden"), false);

    await panel.goto("#reports");
    assert.match(panel.document.els.get("rpTabs")!.innerHTML, /Open<span class="badge">2<\/span>/);
    const table = panel.document.els.get("rpTable")!.innerHTML;
    assert.match(table, /data-to="#reports\/5"/);
    assert.match(table, /Offensive behavior/);
    assert.match(table, /2 open reports/);
    assert.equal(table.includes(EVIL), false, "report text must be escaped");
    assert.ok(panel.requests.some((r) => r.includes("/reports?tab=open")));

    await panel.goto("#reports/5");
    const detail = panel.content();
    assert.match(detail, /<h1>Report #5<\/h1>/);
    assert.match(detail, /data-act="rpResolve"/);
    assert.match(detail, /data-act="rpDismiss"/);
    assert.match(detail, /Resolve all 2 against player/);
    assert.match(detail, /Reported message/);
    assert.match(detail, /GM_MUTE/);
    assert.equal(detail.includes(EVIL), false);

    await panel.goto(`#players/${USER}/reports`);
    assert.match(panel.document.els.get("pReports")!.innerHTML, /Reports received/);
    assert.ok(panel.requests.some((r) => r.includes(`/reports?tab=all&target=${USER}`)));
    assert.ok(panel.requests.some((r) => r.includes(`/reports?tab=all&reporter=${USER}`)));
    await panel.goto("#players");
    assert.match(panel.document.els.get("plTabs")!.innerHTML, /Reported<span class="badge">2<\/span>/);
  });

  it("refreshes the player page on the same tab after a moderation action", async () => {
    const panel = boot([[/\/players\/[^/?]+\/unban$/, { ok: true }], ...ANSWERS]);
    await panel.goto(`#players/${USER}/wallet`);
    await panel.clickAct("pUnban");
    await panel.confirmDialog();
    assert.ok(panel.requests.includes(`POST /admin/runtime/players/${USER}/unban`));
    assert.equal(panel.requests.filter((r) => r === `GET /admin/runtime/players/${USER}`).length, 2, "the detail is loaded again after the action");
    assert.match(panel.document.els.get("pBody")!.innerHTML, /Grant currency/, "still on the wallet tab");
  });

  it("renders the chat word filter panel and its test box", async () => {
    const panel = boot();
    await panel.goto("#chat");
    await panel.clickAct("chatScope", { "data-tab": "filter" });
    const filter = panel.document.els.get("chTable")!.innerHTML;
    assert.match(filter, /Test filter/);
    assert.match(filter, /Whole words only/);
    assert.match(filter, /Players filtered since the server started/);
    assert.equal(filter.includes(EVIL), false);

    panel.document.els.get("fiTestInput")!.value = "a shit";
    await panel.clickAct("fiTest");
    const out = panel.document.els.get("fiTestOut")!.innerHTML;
    assert.match(out, /Masked/);
    assert.equal(out.includes(EVIL), false);
    assert.ok(panel.requests.some((r) => r.includes("/chat/filter/test?text=a%20shit")));
  });

  it("renders the logs view with counts, escaped text and expandable details", async () => {
    const panel = boot();
    await panel.goto("#logs");
    assert.match(panel.content(), /<h1>Logs<\/h1>/);
    const chips = panel.document.els.get("lgChips")!.innerHTML;
    assert.match(chips, /data-level="error"/);
    assert.match(chips, /<b>2<\/b>/);
    const table = panel.document.els.get("lgTable")!.innerHTML;
    assert.match(table, /SummonRoom/);
    assert.match(table, /Redis ready/);
    assert.match(table, /x3/);
    assert.match(table, /Load older/);
    assert.equal(table.includes(EVIL), false, "log text must be escaped");
    assert.equal(panel.document.els.get("lgFilters")!.innerHTML.includes(EVIL), false);

    await panel.clickAct("lgToggle", { "data-id": "9" });
    const open = panel.document.els.get("lgTable")!.innerHTML;
    assert.match(open, /Copy entry/);
    assert.match(open, /Error: boom/);
    assert.match(open, /player 11111111/);
    assert.equal(open.includes(EVIL), false);

    await panel.clickAct("lgLevel", { "data-level": "error" });
    assert.ok(panel.requests.some((r) => r.includes("/logs?levels=error")));
    await panel.clickAct("lgMore");
    assert.ok(panel.requests.some((r) => r.includes("before=7")));
    await panel.clickAct("lgAuto");
    assert.equal(panel.document.els.get("lgAuto")!.textContent, "Auto-refresh: on");
  });

  it("renders runtime, rooms and grants without errors", async () => {
    const panel = boot();
    await panel.goto("#runtime");
    assert.match(panel.content(), /Enable maintenance/);
    await panel.goto("#rooms");
    assert.match(panel.document.els.get("roomsBody")!.innerHTML, /presence/);
    await panel.goto("#grants");
    assert.match(panel.content(), /Grant currency/);
    await panel.goto("#nothing");
    assert.match(panel.content(), /<h1>Overview<\/h1>/);
  });

  it("only issues GET requests while browsing", async () => {
    const panel = boot();
    for (const hash of ["#overview", "#players", `#players/${USER}`, `#players/${USER}/reports`, "#guilds", "#chat", "#reports", "#reports/5", "#mail", "#audit", "#logs", "#config", "#rooms"]) await panel.goto(hash);
    assert.deepEqual(panel.requests.filter((r) => !r.startsWith("GET ")), []);
    assert.equal(panel.requests.some((r) => r.includes("NOT_MOCKED")), false);
  });
});
