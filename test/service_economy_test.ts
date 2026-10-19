import assert from "node:assert/strict";

import { FixedClock } from "../src/shared/kernel/clock";
import { applyRecharge, creditedAmount } from "../src/modules/economy/economy.domain";
import { EconomyService } from "../src/modules/economy/economy.service";
import { WalletLedger } from "../src/modules/economy/wallet-ledger";
import { AppError } from "../src/shared/errors/app-error";
import { currencyRulesOf, InMemoryUnitOfWork, InMemoryWalletRepository, SESSION } from "./support/fakes";

const USER = "user-1";
const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);

const currencies = currencyRulesOf([
  { id: "energy", initialAmount: 30, rechargeable: true, rechargeAmount: 1, rechargeIntervalSeconds: 300, rechargeOffline: true, hasCap: true, baseCap: 50 },
  { id: "gold", initialAmount: 1000 },
  { id: "shard", canFuse: true, fusionTargetCurrencyId: "crystal", fusionRequiredAmount: 10, fusionExtraCostCurrencyId: "gold", fusionExtraCostAmount: 100 },
  { id: "crystal", hasCap: true, baseCap: 5 },
]);

function setup() {
  const clock = new FixedClock(T0);
  const wallets = new InMemoryWalletRepository();
  const uow = new InMemoryUnitOfWork().register(wallets);
  const ledger = new WalletLedger(wallets, currencies, clock);
  const economy = new EconomyService(wallets, ledger, currencies, uow, clock);
  return { clock, wallets, uow, ledger, economy };
}

describe("Economy domain", () => {
  const energy = currencies.get("energy")!;

  it("first recharge only stamps lastTickAt", () => {
    const row = { currencyId: "energy", amount: 10, lastTickAt: null };
    assert.equal(applyRecharge(row, energy, 1, T0), true);
    assert.equal(row.amount, 10);
    assert.equal(row.lastTickAt!.getTime(), T0);
  });

  it("grants whole intervals and carries the remainder", () => {
    const row = { currencyId: "energy", amount: 10, lastTickAt: new Date(T0) };
    applyRecharge(row, energy, 1, T0 + 650_000); // 2 ticks + 50 s
    assert.equal(row.amount, 12);
    assert.equal(row.lastTickAt!.getTime(), T0 + 600_000);
  });

  it("never lowers a balance above the cap", () => {
    const row = { currencyId: "energy", amount: 80, lastTickAt: new Date(T0) };
    applyRecharge(row, energy, 1, T0 + 3_000_000);
    assert.equal(row.amount, 80);
    assert.equal(creditedAmount(80, 5, energy, 1), 80);
    assert.equal(creditedAmount(45, 10, energy, 1), 50);
  });

  it("recharge stops at the cap even when grants may overflow it", () => {
    const overflowEnergy = { ...energy, canOverflowAboveCap: true };
    const above = { currencyId: "energy", amount: 80, lastTickAt: new Date(T0) };
    applyRecharge(above, overflowEnergy, 1, T0 + 3_000_000);
    assert.equal(above.amount, 80);
    const below = { currencyId: "energy", amount: 48, lastTickAt: new Date(T0) };
    applyRecharge(below, overflowEnergy, 1, T0 + 3_000_000); // 10 ticks, only 2 fit under the cap
    assert.equal(below.amount, 50);
    assert.equal(creditedAmount(80, 5, overflowEnergy, 1), 85);
  });
});

describe("EconomyService / WalletLedger", () => {
  it("creates missing currencies with their initial amounts", async () => {
    const { economy, wallets } = setup();
    wallets.set(USER, "gold", 5);
    await economy.ensureUserCurrencies(USER);
    assert.equal(wallets.amount(USER, "gold"), 5);
    assert.equal(wallets.amount(USER, "energy"), 30);
  });

  it("applies pending recharge before spending and rejects insufficient funds", async () => {
    const { economy, wallets, clock } = setup();
    wallets.set(USER, "energy", 2, new Date(T0));
    clock.advance(900_000); // +3
    assert.equal(await economy.spend(USER, "energy", 5), 0);
    await assert.rejects(economy.spend(USER, "energy", 1), (error: unknown) => error instanceof AppError && error.errorCode === "ECON_INSUFFICIENT_FUNDS");
  });

  it("fuses currencies atomically and respects the output cap", async () => {
    const { economy, wallets } = setup();
    wallets.set(USER, "shard", 25);
    wallets.set(USER, "gold", 150);
    wallets.set(USER, "crystal", 4);

    await assert.rejects(economy.fuse(USER, "shard", 2), (error: unknown) => error instanceof AppError && error.errorCode === "ECON_INSUFFICIENT_COST");
    assert.equal(wallets.amount(USER, "shard"), 25, "rolled back");

    const wallet = await economy.fuse(USER, "shard", 1);
    assert.deepEqual(wallet, { shard: 15, gold: 50, crystal: 5 });
  });

  it("debits several currencies in one call and merges duplicates", async () => {
    const { ledger, wallets } = setup();
    wallets.set(USER, "gold", 100);
    const result = await ledger.debit(SESSION, USER, [{ currencyId: "gold", amount: 30 }, { currencyId: "gold", amount: 20 }]);
    assert.deepEqual(result, { gold: 50 });
  });
});
