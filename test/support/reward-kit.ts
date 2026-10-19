// Reward granter over in-memory fakes (mail and guild quest service tests).

import { AppError } from "../../src/shared/errors/app-error";
import { ErrorCode } from "../../src/shared/errors/error-codes";
import type { FixedClock } from "../../src/shared/kernel/clock";
import { WalletLedger } from "../../src/modules/economy/wallet-ledger";
import { RewardGranter } from "../../src/modules/rewards/reward-granter";
import type { CharacterGrantService } from "../../src/modules/roster/character-grant.service";
import type { RuneSyncDto } from "../../src/modules/rune/rune.dto";
import type { RuneService } from "../../src/modules/rune/rune.service";
import { currencyRulesOf, InMemoryCharacterRepository, InMemoryWalletRepository } from "./fakes";

/** Reward granter over in-memory wallets; `runeRoom` = free rune slots (null = unlimited). */
export function rewardKit(clock: FixedClock) {
  const wallets = new InMemoryWalletRepository();
  const characters = new InMemoryCharacterRepository();
  const currencies = currencyRulesOf([{ id: "DM" }, { id: "GO" }, { id: "EN" }, { id: "AW" }, { id: "mystic_scroll_cur" }]);
  const ledger = new WalletLedger(wallets, currencies, clock);
  const kit = { wallets, ledger, runeRoom: null as number | null, runesGranted: 0 };
  const runes = {
    grantRunes: async (_session: unknown, _userId: string, specs: unknown[]): Promise<RuneSyncDto[]> => {
      if (kit.runeRoom !== null && specs.length > kit.runeRoom) throw new AppError(ErrorCode.RUNE_CAPACITY_FULL);
      if (kit.runeRoom !== null) kit.runeRoom -= specs.length;
      kit.runesGranted += specs.length;
      return specs.map((_, index) => ({ uid: `r${kit.runesGranted}-${index}` }) as unknown as RuneSyncDto);
    },
  } as unknown as RuneService;
  const rewards = new RewardGranter({
    ledger,
    characters,
    characterGrants: { grant: async () => [] } as unknown as CharacterGrantService,
    runes,
    constructions: { exists: () => false, ownedCount: async () => 0, grant: async () => undefined },
    scrolls: { get: () => undefined },
    currencies,
  });
  return { ...kit, kit, rewards };
}
