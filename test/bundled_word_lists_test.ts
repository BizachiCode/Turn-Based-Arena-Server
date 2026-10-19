import { strict as assert } from "assert";
import { bundledWords, selectedBundledLanguages } from "../src/config/BundledWordLists.js";
import { applyChatFilter, compileChatFilter } from "../src/modules/chat/chat-filter.js";

describe("Bundled chat filter word lists (wordlists/)", () => {
  it("removes the project's exclusions, adds its extras and skips phrases", () => {
    const pt = bundledWords("pt");
    assert.ok(pt.includes("porra"));
    assert.ok(pt.includes("fdp"), "extra/pt.txt");
    for (const ordinary of ["comer", "cerveja", "aranha", "saco", "bissexual"]) assert.ok(!pt.includes(ordinary), ordinary);
    assert.ok(pt.every((word) => !/\s/u.test(word)), "phrases are skipped");
    const en = bundledWords("en");
    assert.ok(en.includes("fuck"));
    for (const gameTerm of ["hardcore", "escort", "domination", "sucks"]) assert.ok(!en.includes(gameTerm), gameTerm);
    assert.deepEqual(bundledWords("xx"), []);
  });

  it("selects every language by default, none for [] and ignores unknown codes", () => {
    assert.deepEqual(selectedBundledLanguages({}), ["en", "pt", "ja", "ko", "zh"]);
    assert.deepEqual(selectedBundledLanguages({ bundledLists: [] }), []);
    assert.deepEqual(selectedBundledLanguages({ bundledLists: ["PT", "pt", "fr"] }), ["pt"]);
  });

  it("filters real chat lines without touching ordinary words", () => {
    const words = ["en", "pt", "ja", "ko", "zh"].flatMap((language) => bundledWords(language));
    const filter = compileChatFilter({ enabled: true, words });
    assert.equal(applyChatFilter(filter, "vou comer uma pizza e tomar cerveja").matched, false);
    assert.equal(applyChatFilter(filter, "this boss is hardcore, escort the healer").matched, false);
    assert.equal(applyChatFilter(filter, "que porra é essa").text, "que ***** é essa");
    assert.equal(applyChatFilter(filter, "f.u.c.k you").matched, true);
  });
});
