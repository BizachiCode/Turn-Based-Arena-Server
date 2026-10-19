import assert from "node:assert/strict";

import { FixedClock } from "../src/shared/kernel/clock";
import { noCache } from "../src/shared/kernel/cache";
import { noAudit } from "../src/shared/kernel/audit";
import { createSeededRandom } from "../src/shared/kernel/random";
import type { PlayerActivityKind } from "../src/shared/kernel/activity";
import type { DbSession, UnitOfWork } from "../src/shared/kernel/unit-of-work";
import type { MapCatalog, MapStage } from "../src/config/MapCatalog";
import { isDeadlockError } from "../src/infrastructure/database/drizzle-unit-of-work";
import { WalletLedger } from "../src/modules/economy/wallet-ledger";
import { MonsterProgression } from "../src/modules/progression/progression.rules";
import { RosterCache } from "../src/modules/roster/roster.cache";
import { RuneCache } from "../src/modules/rune/rune.cache";
import type { RuneService } from "../src/modules/rune/rune.service";
import { BattleRewardService } from "../src/modules/battle-pve/battle-rewards.service";
import {
  currencyRulesOf,
  InMemoryCharacterRepository,
  InMemoryMapProgressRepository,
  InMemoryPveBattleRepository,
  InMemoryUnitOfWork,
  InMemoryWalletRepository,
  SESSION,
} from "./support/fakes";

const USER = "user-1";

const stage: MapStage = {
  id: "s1",
  currencyId: "EN",
  costs: [],
  formation: { front: 2, back: 2, leaderIndex: 0 },
  rewards: [{
    difficulty: "Easy",
    currencies: [{ currencyId: "gold", amount: 300 }],
    firstClearCurrencies: [],
    unitExp: 50,
    accountExp: 0,
    dropTable: { id: "t", rune: null, items: [] },
    randomDrops: [],
  }],
};
const catalog: MapCatalog = { regions: [{ id: "r1", kind: "story", stageCount: 1, stages: [stage] }] };

function setup(wrapUow: (inner: InMemoryUnitOfWork) => UnitOfWork = (inner) => inner) {
  const wallets = new InMemoryWalletRepository();
  const characters = new InMemoryCharacterRepository();
  const battles = new InMemoryPveBattleRepository();
  const progress = new InMemoryMapProgressRepository();
  const inner = new InMemoryUnitOfWork().register(wallets).register(characters).register(battles).register(progress);
  const clock = new FixedClock(Date.UTC(2026, 9, 5));
  const ledger = new WalletLedger(wallets, currencyRulesOf([{ id: "gold" }]), clock);
  const progression = new MonsterProgression({
    starTiers: () => [{ stars: 2, maxLevel: 5, expPerLevel: [100, 100, 100, 100] }],
    powerUp: () => ({ currencyId: "gold", costPerFodderStarUnit: 0, expMultiplierByStars: [], minFodderBaseLevel: 2 }),
    evolve: () => ({ currencyId: "gold", costPerStarUnit: 0, steps: [] }),
  });
  const activity: PlayerActivityKind[] = [];
  const rewards = new BattleRewardService(
    battles, progress, { catalog: () => catalog, getStage: () => stage },
    ledger, characters, progression, {} as unknown as RuneService, new RosterCache(noCache), new RuneCache(noCache),
    createSeededRandom(1), wrapUow(inner), clock, noAudit, { record: async (_user, kind) => { activity.push(kind); } },
  );
  return { wallets, characters, battles, ledger, rewards, activity };
}

async function startedBattle(battles: InMemoryPveBattleRepository, battleId: string) {
  await battles.createTicket({ id: `t-${battleId}`, userId: USER, regionId: "r1", stageId: "s1", difficulty: "Easy", currencyId: "energy", energySpent: 3 }, SESSION);
  await battles.consumeTicket(USER, { regionId: "r1", stageId: "s1", difficulty: "Easy" }, battleId, new Date(0), null);
}

describe("Battle settlement lock order and deadlock retry", () => {
  it("locks the characters before crediting the wallet (same order as power-up / summon / sell)", async () => {
    const { characters, ledger, battles, rewards } = setup();
    characters.add(USER, { uid: "U1", characterId: "c1", stars: 2, level: 1 });
    await startedBattle(battles, "B1");

    const order: string[] = [];
    const lockByUids = characters.lockByUids.bind(characters);
    characters.lockByUids = async (...args: Parameters<typeof lockByUids>) => { order.push("characters"); return lockByUids(...args); };
    const credit = ledger.credit.bind(ledger);
    ledger.credit = async (...args: Parameters<typeof credit>) => { order.push("wallet"); return credit(...args); };

    const result = await rewards.settle(USER, { battleId: "B1", victory: true, unitUids: ["U1"], clearMs: null });
    assert.equal(result.victory, true);
    assert.deepEqual(order, ["characters", "wallet"]);
  });

  it("grants everything once and records activity once when the transaction is re-run after a deadlock", async () => {
    // The first attempt runs the whole callback, then the database reports a deadlock victim (rolled back).
    class DeadlockOnceUow implements UnitOfWork {
      attempts = 0;
      constructor(private readonly inner: InMemoryUnitOfWork) {}
      async transaction<T>(work: (session: DbSession) => Promise<T>): Promise<T> {
        for (;;) {
          this.attempts++;
          const attempt = this.attempts;
          try {
            return await this.inner.transaction(async (session) => {
              const value = await work(session);
              if (attempt === 1) throw Object.assign(new Error("deadlock"), { errno: 1213 });
              return value;
            });
          } catch (error) {
            if (attempt >= 3 || !isDeadlockError(error)) throw error;
          }
        }
      }
    }
    let uow!: DeadlockOnceUow;
    const { wallets, characters, battles, rewards, activity } = setup((inner) => (uow = new DeadlockOnceUow(inner)));
    characters.add(USER, { uid: "U1", characterId: "c1", stars: 2, level: 1 });
    await startedBattle(battles, "B1");

    const result = await rewards.settle(USER, { battleId: "B1", victory: true, unitUids: ["U1"], clearMs: null });
    assert.equal(result.victory, true);
    assert.equal(uow.attempts, 2);
    assert.equal(wallets.amount(USER, "gold"), 300, "the rolled-back attempt left nothing behind");
    assert.deepEqual(activity.filter((kind) => kind === "stage_clear"), ["stage_clear"]);
  });
});
