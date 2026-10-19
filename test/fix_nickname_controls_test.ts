import assert from "node:assert/strict";

import { validateNickname } from "../src/modules/profile/profile.service";

describe("Nickname validation: control and format characters", () => {
  const open = { minLength: 3, maxLength: 25, canUseSpecialChar: true };

  it("refuses terminal escapes, zero-width / direction marks and separators even with special characters on", () => {
    for (const name of ["\u0001\u0002\u001b[31m\u007f", "Ann​ie", "Bob‮yb", "Cid ra", "Danny", "Tab\tname"]) {
      assert.equal(validateNickname(name, open), "INVALID_CHARS", JSON.stringify(name));
    }
  });

  it("keeps accepting letters of any script, symbols and emoji when special characters are on", () => {
    for (const name of ["Ana Clara", "李小龍", "Zoë_99", "★Star★", "Fire🔥Lord"]) {
      assert.equal(validateNickname(name, open), null, name);
    }
    assert.equal(validateNickname("★Star★", { ...open, canUseSpecialChar: false }), "INVALID_CHARS");
  });
});
