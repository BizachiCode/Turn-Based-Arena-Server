import assert from "node:assert/strict";

import { noCache } from "../src/shared/kernel/cache";
import { FixedClock } from "../src/shared/kernel/clock";
import type { PlayerActivityKind, PlayerActivitySink } from "../src/shared/kernel/activity";
import { WalletLedger } from "../src/modules/economy/wallet-ledger";
import { RuneCache } from "../src/modules/rune/rune.cache";
import type { RuneGenerator } from "../src/modules/rune/rune.generator";
import type { RuneRecord, RuneRepository, RuneRules } from "../src/modules/rune/rune.ports";
import { RuneService } from "../src/modules/rune/rune.service";
import { currencyRulesOf, InMemoryUnitOfWork, InMemoryWalletRepository } from "./support/fakes";

const USER = "user-1";

/** Just enough of the repository for upgrade + sell. */
function stubRunes(): RuneRepository {
  const rows = new Map<string, RuneRecord>();
  for (const uid of ["R1", "R2"]) {
    rows.set(uid, {
      id: 1, uid, setId: "Energy", slot: 1, tier: 2, variant: "Normal", quality: 1, level: 0, mainStatType: "ATKFlat",
      mainStatValue: 10, substats: [], origin: null, locked: false, favorite: false, equippedToUid: null, equippedAt: null,
    } as unknown as RuneRecord);
  }
  return {
    find: async (_user: string, uid: string) => rows.get(uid) ?? null,
    updateProgress: async () => undefined,
    delete: async (_user: string, uid: string) => (rows.delete(uid) ? 1 : 0),
  } as unknown as RuneRepository;
}

const rules = {
  catalog: () => ({ config: { maxLevel: 15 } }),
  upgradeCost: () => 100,
  upgradeCurrencyId: () => "GO",
} as unknown as RuneRules;

const generator = {
  rollUpgrade: (rune: RuneRecord) => ({ success: true, level: rune.level + 1, mainStatValue: rune.mainStatValue + 1, substats: rune.substats }),
} as unknown as RuneGenerator;

describe("Rune activity (missions / quests feed)", () => {
  it("records rune_upgrade for an upgrade but not for a sale", async () => {
    const wallets = new InMemoryWalletRepository();
    wallets.set(USER, "GO", 1000);
    const runes = stubRunes();
    const uow = new InMemoryUnitOfWork().register(wallets);
    const ledger = new WalletLedger(wallets, currencyRulesOf([{ id: "GO" }]), new FixedClock(0));
    const events: PlayerActivityKind[] = [];
    const activity: PlayerActivitySink = { record: async (_user, kind) => { events.push(kind); } };
    const service = new RuneService(runes, generator, rules, ledger, new RuneCache(noCache), uow, activity);

    await service.sell(USER, "R1");
    assert.deepEqual(events, [], "selling a rune is not an upgrade");

    await service.upgrade(USER, "R2");
    assert.deepEqual(events, ["rune_upgrade"]);
  });
});
