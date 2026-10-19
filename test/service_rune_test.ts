import assert from "node:assert/strict";

import { FixedClock } from "../src/shared/kernel/clock";
import { InMemoryCache } from "../src/shared/kernel/cache";
import { AppError } from "../src/shared/errors/app-error";
import { WalletLedger } from "../src/modules/economy/wallet-ledger";
import { RuneCache } from "../src/modules/rune/rune.cache";
import type { RuneGenerator } from "../src/modules/rune/rune.generator";
import type { NewRune, RuneRecord, RuneRepository, RuneRules, RuneSearchFilters, Substat } from "../src/modules/rune/rune.ports";
import { RuneService } from "../src/modules/rune/rune.service";
import { Idempotency } from "../src/shared/kernel/idempotency";
import { currencyRulesOf, InMemoryUnitOfWork, InMemoryWalletRepository } from "./support/fakes";
import { InMemoryRequestResultStore } from "./support/idempotency-fakes";

const USER = "user-1";
const OTHER = "user-2";

type OwnedRune = RuneRecord & { userId: string };

/** In-memory {@link RuneRepository} (rows keyed by public uid, characters as `userId|uid`). */
class InMemoryRuneRepository implements RuneRepository {
  rows: OwnedRune[] = [];
  characters = new Set<string>();
  private nextId = 1;

  add(userId: string, rune: Partial<RuneRecord> & { uid: string }): void {
    this.rows.push({
      id: this.nextId++,
      userId,
      setId: "Energy",
      slot: 1,
      tier: 6,
      variant: "Normal",
      quality: 3,
      level: 0,
      mainStatType: "ATKFlat",
      mainStatValue: 22,
      substats: [],
      origin: null,
      locked: false,
      favorite: false,
      equippedToUid: null,
      equippedAt: null,
      createdAt: new Date(0),
      ...rune,
    });
  }

  row(uid: string): OwnedRune | undefined {
    return this.rows.find((entry) => entry.uid === uid);
  }

  private owned(userId: string): OwnedRune[] {
    return this.rows.filter((entry) => entry.userId === userId);
  }

  private static strip({ userId: _owner, ...record }: OwnedRune): RuneRecord {
    return { ...record, substats: record.substats.map((sub) => ({ ...sub })) };
  }

  async search(userId: string, filters: RuneSearchFilters): Promise<RuneRecord[]> {
    return this.owned(userId).slice(0, filters.pageSize).map(InMemoryRuneRepository.strip);
  }

  async freeCountsBySet(userId: string): Promise<Array<{ setId: string; count: number }>> {
    const counts = new Map<string, number>();
    for (const rune of this.owned(userId)) if (!rune.equippedToUid) counts.set(rune.setId, (counts.get(rune.setId) ?? 0) + 1);
    return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([setId, count]) => ({ setId, count }));
  }

  async lockCapacity(userId: string, defaultCapacity: number): Promise<{ capacity: number; count: number }> {
    return { capacity: defaultCapacity, count: this.owned(userId).length };
  }

  async insertRune(userId: string, rune: NewRune): Promise<void> {
    this.add(userId, rune);
  }

  async find(userId: string, uid: string): Promise<RuneRecord | null> {
    const rune = this.owned(userId).find((entry) => entry.uid === uid);
    return rune ? InMemoryRuneRepository.strip(rune) : null;
  }

  async listEquippedOn(userId: string, characterUids: string[]): Promise<RuneRecord[]> {
    return this.owned(userId).filter((entry) => entry.equippedToUid && characterUids.includes(entry.equippedToUid)).map(InMemoryRuneRepository.strip);
  }

  async updateProgress(userId: string, uid: string, level: number, mainStatValue: number, substats: Substat[]): Promise<void> {
    const rune = this.owned(userId).find((entry) => entry.uid === uid);
    if (rune) Object.assign(rune, { level, mainStatValue, substats });
  }

  async delete(userId: string, uid: string): Promise<number> {
    const before = this.rows.length;
    this.rows = this.rows.filter((entry) => !(entry.userId === userId && entry.uid === uid));
    return before - this.rows.length;
  }

  async setFlags(userId: string, uid: string, flags: { locked?: boolean; favorite?: boolean }): Promise<number> {
    const rune = this.owned(userId).find((entry) => entry.uid === uid);
    if (!rune || (flags.locked === undefined && flags.favorite === undefined)) return 0;
    if (flags.locked !== undefined) rune.locked = flags.locked;
    if (flags.favorite !== undefined) rune.favorite = flags.favorite;
    return 1;
  }

  async characterExists(userId: string, characterUid: string): Promise<boolean> {
    return this.characters.has(`${userId}|${characterUid}`);
  }

  async clearSlot(userId: string, characterUid: string, slot: number): Promise<number> {
    let cleared = 0;
    for (const rune of this.owned(userId)) {
      if (rune.equippedToUid === characterUid && rune.slot === slot) {
        Object.assign(rune, { equippedToUid: null, equippedAt: null });
        cleared++;
      }
    }
    return cleared;
  }

  async setEquipped(userId: string, uid: string, characterUid: string | null): Promise<number> {
    const rune = this.owned(userId).find((entry) => entry.uid === uid);
    if (!rune) return 0;
    Object.assign(rune, { equippedToUid: characterUid, equippedAt: characterUid ? new Date(0) : null });
    return 1;
  }

  snapshot(): unknown {
    return this.rows.map((entry) => ({ ...entry, substats: entry.substats.map((sub) => ({ ...sub })) }));
  }

  restore(state: unknown): void {
    this.rows = state as OwnedRune[];
  }
}

const rules = {
  catalog: () => ({ config: { maxLevel: 15 } }),
  upgradeCost: () => 100,
  upgradeCurrencyId: () => "GO",
} as unknown as RuneRules;

/** Upgrades always succeed (+1 level) so the tests stay deterministic. */
const generator = {
  rollUpgrade: (rune: RuneRecord) => ({ success: true, level: rune.level + 1, mainStatValue: rune.mainStatValue + 5, substats: rune.substats }),
} as unknown as RuneGenerator;

function setup() {
  const wallets = new InMemoryWalletRepository();
  const runes = new InMemoryRuneRepository();
  const results = new InMemoryRequestResultStore();
  const uow = new InMemoryUnitOfWork().register(wallets).register(runes).register(results);
  const ledger = new WalletLedger(wallets, currencyRulesOf([{ id: "GO" }]), new FixedClock(0));
  const activity: string[] = [];
  const service = new RuneService(runes, generator, rules, ledger, new RuneCache(new InMemoryCache()), uow,
    { record: async (_user: string, kind: string) => { activity.push(kind); } }, new Idempotency(results, uow));
  return { wallets, runes, service, activity };
}

const isError = (code: string) => (error: unknown) => error instanceof AppError && error.errorCode === code;

describe("RuneService lock / favorite / delete / counts", () => {
  it("protects locked runes from sell and delete until they are unlocked", async () => {
    const { wallets, runes, service } = setup();
    wallets.set(USER, "GO", 500);
    runes.add(USER, { uid: "R1" });

    assert.deepEqual(await service.setLock(USER, "R1", true), { runeUid: "R1", locked: true });
    await assert.rejects(service.sell(USER, "R1"), isError("RUNE_LOCKED"));
    await assert.rejects(service.remove(USER, "R1"), isError("RUNE_LOCKED"));
    assert.equal(wallets.amount(USER, "GO"), 500);
    assert.equal(runes.row("R1")?.locked, true);

    assert.deepEqual(await service.setLock(USER, "R1", false), { runeUid: "R1", locked: false });
    assert.deepEqual(await service.remove(USER, "R1"), { removedUid: "R1" });
    assert.equal(runes.row("R1"), undefined);
    assert.equal(wallets.amount(USER, "GO"), 500); // delete never refunds
  });

  it("reports why a delete was refused and never touches other players' runes", async () => {
    const { runes, service } = setup();
    runes.add(OTHER, { uid: "FOREIGN" });
    runes.add(USER, { uid: "WORN", equippedToUid: "C1" });

    await assert.rejects(service.remove(USER, "MISSING"), isError("RUNE_NOT_FOUND"));
    await assert.rejects(service.remove(USER, "FOREIGN"), isError("RUNE_NOT_FOUND"));
    await assert.rejects(service.remove(USER, "WORN"), isError("RUNE_ALREADY_EQUIPPED"));
    assert.ok(runes.row("FOREIGN"));
    assert.ok(runes.row("WORN"));
  });

  it("sets flags idempotently, only on the owner's runes; favorites can still be sold", async () => {
    const { wallets, runes, service } = setup();
    runes.add(USER, { uid: "R1", tier: 2, quality: 1, level: 0 });
    runes.add(OTHER, { uid: "FOREIGN" });

    assert.deepEqual(await service.setLock(USER, "R1", true), { runeUid: "R1", locked: true });
    assert.deepEqual(await service.setLock(USER, "R1", true), { runeUid: "R1", locked: true });
    assert.deepEqual(await service.setFavorite(USER, "R1", true), { runeUid: "R1", favorite: true });
    await assert.rejects(service.setLock(USER, "FOREIGN", true), isError("RUNE_NOT_FOUND"));
    await assert.rejects(service.setFavorite(USER, "MISSING", true), isError("RUNE_NOT_FOUND"));
    assert.equal(runes.row("FOREIGN")?.locked, false);

    // The search snapshot carries both flags (0/1 on the wire).
    const [item] = await service.search(USER, {});
    assert.equal(item.locked, 1);
    assert.equal(item.favorite, 1);

    await service.setLock(USER, "R1", false);
    const sold = await service.sell(USER, "R1");
    assert.equal(sold.gained, 200); // 100 * tier 2 * quality 1
    assert.equal(wallets.amount(USER, "GO"), 200);
  });

  it("still lets a locked rune be equipped and upgraded (the lock survives)", async () => {
    const { wallets, runes, service } = setup();
    wallets.set(USER, "GO", 1000);
    runes.characters.add(`${USER}|C1`);
    runes.add(USER, { uid: "R1", slot: 2, locked: true });

    await service.equip(USER, "R1", "C1");
    const upgraded = await service.upgrade(USER, "R1");
    assert.equal(upgraded.success, true);
    assert.equal(upgraded.rune.level, 1);
    assert.equal(upgraded.rune.locked, 1);
    assert.equal(upgraded.rune.equippedToUid, "C1");
    assert.equal(runes.row("R1")?.locked, true);
    assert.equal(wallets.amount(USER, "GO"), 900);
  });

  it("counts free (unequipped) runes per set, locked ones included, and refreshes after a delete", async () => {
    const { runes, service } = setup();
    runes.add(USER, { uid: "E1", setId: "Energy" });
    runes.add(USER, { uid: "E2", setId: "Energy", equippedToUid: "C1" });
    runes.add(USER, { uid: "B1", setId: "Blade", locked: true });
    runes.add(OTHER, { uid: "X1", setId: "Swift" });

    assert.deepEqual(await service.setCounts(USER), [
      { setId: "Blade", freeCount: 1 },
      { setId: "Energy", freeCount: 1 },
    ]);

    await service.remove(USER, "E1");
    assert.deepEqual(await service.setCounts(USER), [{ setId: "Blade", freeCount: 1 }]);
  });
});

describe("RuneService upgrade with a request id", () => {
  it("a retry with the same id answers the first upgrade without paying or rolling again", async () => {
    const { wallets, runes, service, activity } = setup();
    wallets.set(USER, "GO", 1000);
    runes.add(USER, { uid: "R1" });

    const first = await service.upgrade(USER, "R1", "up-1");
    assert.equal(first.rune.level, 1);
    assert.equal(first.wallet.GO, 900, "the wallet of the first response is read inside the transaction");

    const retry = await service.upgrade(USER, "R1", "up-1");
    assert.deepEqual(retry, { ...first, replayed: true });
    assert.equal(runes.row("R1")?.level, 1);
    assert.equal(wallets.amount(USER, "GO"), 900);
    assert.equal(activity.filter((kind) => kind === "rune_upgrade").length, 1);

    const next = await service.upgrade(USER, "R1", "up-2");
    assert.equal(next.rune.level, 2, "a new id is a new upgrade");
    assert.equal(wallets.amount(USER, "GO"), 800);
  });

  it("without a request id every call is a new upgrade", async () => {
    const { wallets, runes, service } = setup();
    wallets.set(USER, "GO", 1000);
    runes.add(USER, { uid: "R1" });
    await service.upgrade(USER, "R1");
    await service.upgrade(USER, "R1");
    assert.equal(runes.row("R1")?.level, 2);
  });
});
