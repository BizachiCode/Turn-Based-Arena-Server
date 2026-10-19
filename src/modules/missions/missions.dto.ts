import type { ShopPackPayload } from "../../config/ShopCatalog.js";
import type { WalletSnapshot } from "../../shared/kernel/types.js";
import type { ShopGrantsDto } from "../shop/shop.dto.js";

export type MissionEntryDto = {
  missionId: string;
  kind: string;
  target: number;
  /** Capped at `target`. */
  progress: number;
  claimed: boolean;
  rewards: ShopPackPayload;
};

export type MissionStateDto = {
  ok: true;
  serverTime: string;
  dayKey: string;
  /** Next daily reset (ISO). */
  dailyResetAt: string;
  daily: MissionEntryDto[];
  dailyBonus: {
    rewards: ShopPackPayload;
    /** Every daily mission claimed and the bonus not yet. */
    claimable: boolean;
    claimed: boolean;
    claimedCount: number;
    total: number;
  };
  achievements: MissionEntryDto[];
};

export type MissionClaimDto = MissionStateDto & { grants: ShopGrantsDto; wallet: WalletSnapshot };

/** One new-player quest of `newbie_quests/state`. */
export type NewbieQuestDto = {
  questId: string;
  kind: string;
  target: number;
  /** Capped at `target` (claimed quests report `target`). */
  progress: number;
  claimed: boolean;
  /** Complete, not claimed and its chapter unlocked. */
  claimable: boolean;
  rewards: ShopPackPayload;
  /** `clear_stage` only. */
  regionId?: string;
  stageId?: string;
  difficulty?: string;
  /** `own_monsters` only: minimum stars. */
  stars?: number;
  /** `rune_level` only: minimum rune level. */
  runeLevel?: number;
};

export type NewbieChapterDto = {
  chapterId: string;
  index: number;
  /** First chapter, or every quest of the previous chapter claimed. */
  unlocked: boolean;
  claimedCount: number;
  total: number;
  /** Chapter completion reward. */
  rewards: ShopPackPayload;
  hasReward: boolean;
  rewardClaimable: boolean;
  rewardClaimed: boolean;
  quests: NewbieQuestDto[];
};

export type NewbieQuestStateDto = {
  ok: true;
  serverTime: string;
  /** Every quest and chapter reward claimed. */
  completed: boolean;
  /** First chapter not finished (the last one once the book is completed). */
  currentChapter: number;
  /** Claimable quests + chapter rewards (badges). */
  claimable: number;
  chapters: NewbieChapterDto[];
};

export type NewbieQuestClaimDto = NewbieQuestStateDto & { grants: ShopGrantsDto; wallet: WalletSnapshot };
