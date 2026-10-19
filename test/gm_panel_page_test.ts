import assert from "node:assert/strict";

import { renderGmPanelPage } from "../src/modules/admin/gm-panel.page";

// The panel is one inline HTML document whose script lives inside String.raw template literals: a stray backtick,
// dollar-brace or unbalanced quote only shows up when the page runs in a browser, so the unit tests parse the script
// and cross-check the element ids, routes and actions.
describe("GM panel page", () => {
  const html = renderGmPanelPage();
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";

  it("embeds a script that parses", () => {
    assert.ok(script.length > 1000, "script block missing");
    assert.doesNotThrow(() => new Function(script));
  });

  it("is self-contained: no external scripts, stylesheets, fonts or images", () => {
    assert.equal(/<script[^>]+src=/i.test(html), false);
    assert.equal(/<link[^>]+href=/i.test(html), false);
    assert.equal(/https?:\/\//i.test(html), false, "the page must not reference external URLs");
    assert.equal(/@import|url\(/i.test(html), false);
  });

  it("finds every element id the script looks up", () => {
    const wanted = [...script.matchAll(/\$\("([A-Za-z0-9_]+)"\)/g)].map((m) => m[1]);
    assert.ok(wanted.length > 20);
    // Ids come from literal markup or from `lookupHtml("<id>", ...)` (autocomplete inputs).
    const missing = [...new Set(wanted)].filter((id) => !html.includes(`id="${id}"`) && !html.includes(`lookupHtml("${id}"`));
    assert.deepEqual(missing, []);
  });

  it("wires every data-act used in the markup to a handler", () => {
    const used = new Set([...html.matchAll(/data-act="([A-Za-z0-9_]+)"/g)].map((m) => m[1]));
    const handlers = new Set([...script.matchAll(/\bA\.([A-Za-z0-9_]+)\s*=/g)].map((m) => m[1]));
    const missing = [...used].filter((name) => !handlers.has(name));
    assert.deepEqual(missing, []);
  });

  it("wires every data-change / data-input-act to a handler", () => {
    const used = new Set([...html.matchAll(/data-(?:change|input-act)="([A-Za-z0-9_]+)"/g)].map((m) => m[1]).filter((name) => name !== "pageSize"));
    const handlers = new Set([...script.matchAll(/\bA\.([A-Za-z0-9_]+)\s*=/g)].map((m) => m[1]));
    assert.deepEqual([...used].filter((name) => !handlers.has(name)), []);
  });

  it("navigates to a view for every sidebar entry", () => {
    const nav = [...html.matchAll(/data-act="nav" data-view="([a-z]+)"/g)].map((m) => m[1]);
    assert.deepEqual(nav, ["overview", "runtime", "rooms", "players", "guilds", "chat", "reports", "grants", "mail", "audit", "logs", "config"]);
    const views = new Set([...script.matchAll(/\bVIEWS\.([a-z]+)\s*=/g)].map((m) => m[1]));
    assert.deepEqual(nav.filter((view) => !views.has(view)), []);
  });

  it("keeps the old marketing copy out and escapes player text through esc()", () => {
    assert.equal(/control room/i.test(html), false);
    // Player-provided fields are only ever concatenated through esc().
    const raw = [...script.matchAll(/\+\s*(?:row|m|g|u|e|c|b|r|s|t|item)\.(?:name|username|nickname|message|title|email|reason|guildName|characterId|setId|userAgent)\s*\+/g)];
    assert.deepEqual(raw.map((m) => m[0]), []);
  });
});
