// New-player quests (beginner missions): a book of chapters with one-time quests, separate from the
// daily missions and achievements.
//
// - Chapter N unlocks once every quest of chapter N-1 was claimed; quests of a locked chapter show their progress
//   but cannot be claimed (`NEWBIE_QUEST_LOCKED`).
// - Counted kinds (summons, stage clears, rune upgrades...) are running counters fed by the activity hub, shared by
//   every quest of that kind (`user_mission_progress` rows `__np:<kind>` in period `newbie`).
// - State kinds (`account_level`, `clear_stage`, `own_monsters`, `rune_level`, `equip_runes`) are read live from the
//   player's account, so they complete for things done before the quest was visible.
// - Claims grant the quest (or chapter) rewards once, in one transaction (rows `<questId>` / `__npch:<chapterId>`).

import { NEWBIE_QUEST_KINDS, STATE_QUEST_KINDS, type NewbieChapterConfig, type NewbieQuestBook, type NewbieQuestConfig, type NewbieQuestKind } from "../../config/NewPlayerQuestCatalog.js";
import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { PlayerActivityKind, PlayerActivityListener } from "../../shared/kernel/activity.js";
import type { AuditLog } from "../../shared/kernel/audit.js";
import type { Clock } from "../../shared/kernel/clock.js";
import { STAGE_DIFFICULTIES, type StageDifficulty } from "../../shared/kernel/types.js";
import type { DbSession, UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import type { WalletLedger } from "../economy/wallet-ledger.js";
import type { RewardGranter } from "../rewards/reward-granter.js";
import type { RosterCache } from "../roster/roster.cache.js";
import type { RuneCache } from "../rune/rune.cache.js";
import type { ShopGrantsDto } from "../shop/shop.dto.js";
import type { NewbieChapterDto, NewbieQuestClaimDto, NewbieQuestDto, NewbieQuestStateDto } from "./missions.dto.js";
import type { MissionProgressRow, MissionRepository } from "./missions.ports.js";
import type { NewbieQuestFacts } from "./newbie-quests.ports.js";

/** Period key of every new-player quest row. */
export const NEWBIE_PERIOD = "newbie";
/** Counter row of a counted kind. */
export const counterId = (kind: string) => `__np:${kind}`;
/** Claim row of a chapter reward. */
export const chapterClaimId = (chapterId: string) => `__npch:${chapterId}`;
/** Counters are uncapped (the quest target caps the shown progress). */
const COUNTER_CAP = 1_000_000_000;

export type NewbieQuestServiceDeps = {
  missions: MissionRepository;
  facts: NewbieQuestFacts;
  rewards: RewardGranter;
  ledger: WalletLedger;
  rosterCache: RosterCache;
  runeCache: RuneCache;
  audit: AuditLog;
  uow: UnitOfWork;
  clock: Clock;
  config: () => NewbieQuestBook;
};

function hasRewards(payload: NewbieChapterConfig["rewards"]): boolean {
  return payload.currencies.length + payload.characters.length + payload.constructions.length + payload.scrolls.length + payload.runes.length > 0;
}

/** Facts loaded once per state/claim (only the ones the book needs). */
type FactSnapshot = {
  level: number;
  clears: Map<string, number>;
  monsters: Map<number, number>;
  runes: Map<number, number>;
  equipped: number;
};

const stageKey = (regionId: string, stageId: string) => `${regionId}\u0000${stageId}`;

export class NewbieQuestService implements PlayerActivityListener {
  constructor(private readonly deps: NewbieQuestServiceDeps) {}

  private get book(): NewbieQuestBook {
    return this.deps.config();
  }

  /** Activity listener: adds to the counter of a counted kind used by the book. */
  async onActivity(userId: string, kind: PlayerActivityKind, amount: number): Promise<void> {
    const book = this.book;
    if (!book.enabled || !(NEWBIE_QUEST_KINDS as readonly string[]).includes(kind)) return;
    const questKind = kind as NewbieQuestKind;
    if (STATE_QUEST_KINDS.has(questKind)) return;
    if (!book.chapters.some((chapter) => chapter.quests.some((quest) => quest.kind === questKind))) return;
    await this.deps.missions.addProgress(userId, NEWBIE_PERIOD, [{ missionId: counterId(questKind), target: COUNTER_CAP }], amount);
  }

  async getState(userId: string): Promise<NewbieQuestStateDto> {
    const book = this.book;
    if (!book.enabled) throw new AppError(ErrorCode.NEWBIE_QUESTS_DISABLED);
    const rows = await this.deps.missions.listProgress(userId, [NEWBIE_PERIOD]);
    const facts = await this.loadFacts(userId, book.chapters.flatMap((chapter) => chapter.quests));
    return this.buildState(book, rows, facts);
  }

  /** Claims a completed quest of an unlocked chapter. */
  async claim(userId: string, questId: string): Promise<NewbieQuestClaimDto> {
    const book = this.book;
    if (!book.enabled) throw new AppError(ErrorCode.NEWBIE_QUESTS_DISABLED);
    const chapterIndex = book.chapters.findIndex((chapter) => chapter.quests.some((quest) => quest.id === questId));
    if (chapterIndex < 0) throw new AppError(ErrorCode.NEWBIE_QUEST_NOT_FOUND);
    const quest = book.chapters[chapterIndex].quests.find((entry) => entry.id === questId)!;
    const now = this.deps.clock.now();

    const grants = await this.deps.uow.transaction(async (session) => {
      const row = await this.deps.missions.lockOrCreate(userId, quest.id, NEWBIE_PERIOD, session);
      if (row.claimedAt) throw new AppError(ErrorCode.NEWBIE_QUEST_CLAIMED);
      const rows = await this.deps.missions.listProgress(userId, [NEWBIE_PERIOD], session);
      if (!this.chapterUnlocked(book, chapterIndex, rows)) throw new AppError(ErrorCode.NEWBIE_QUEST_LOCKED);
      const facts = await this.loadFacts(userId, [quest], session);
      if (this.progressOf(quest, rows, facts) < this.targetOf(quest)) throw new AppError(ErrorCode.NEWBIE_QUEST_NOT_COMPLETE);

      const granted = await this.deps.rewards.grant(session, userId, quest.rewards, { runeOrigin: "newbie_quest" });
      await this.deps.missions.markClaimed(userId, quest.id, NEWBIE_PERIOD, now, session);
      await this.deps.audit.record({ userId, kind: "NEWBIE_QUEST_CLAIM", meta: { questId: quest.id, currencies: granted.currencies } }, session);
      return granted;
    });

    return this.claimResponse(userId, grants);
  }

  /** Claims a chapter reward once every quest of that (unlocked) chapter was claimed. */
  async claimChapter(userId: string, chapterId: string): Promise<NewbieQuestClaimDto> {
    const book = this.book;
    if (!book.enabled) throw new AppError(ErrorCode.NEWBIE_QUESTS_DISABLED);
    const chapterIndex = book.chapters.findIndex((chapter) => chapter.id === chapterId);
    const chapter = book.chapters[chapterIndex];
    if (!chapter || !hasRewards(chapter.rewards)) throw new AppError(ErrorCode.NEWBIE_QUEST_NOT_FOUND);
    const now = this.deps.clock.now();

    const grants = await this.deps.uow.transaction(async (session) => {
      const row = await this.deps.missions.lockOrCreate(userId, chapterClaimId(chapter.id), NEWBIE_PERIOD, session);
      if (row.claimedAt) throw new AppError(ErrorCode.NEWBIE_QUEST_CLAIMED);
      const rows = await this.deps.missions.listProgress(userId, [NEWBIE_PERIOD], session);
      if (!this.chapterUnlocked(book, chapterIndex, rows)) throw new AppError(ErrorCode.NEWBIE_QUEST_LOCKED);
      if (!chapter.quests.every((quest) => isClaimed(rows, quest.id))) throw new AppError(ErrorCode.NEWBIE_QUEST_NOT_COMPLETE);

      const granted = await this.deps.rewards.grant(session, userId, chapter.rewards, { runeOrigin: "newbie_quest" });
      await this.deps.missions.markClaimed(userId, chapterClaimId(chapter.id), NEWBIE_PERIOD, now, session);
      await this.deps.audit.record({ userId, kind: "NEWBIE_CHAPTER_CLAIM", meta: { chapterId: chapter.id, currencies: granted.currencies } }, session);
      return granted;
    });

    return this.claimResponse(userId, grants);
  }

  // ───────────────────────── rules ─────────────────────────

  /** Chapter 0 is always open; chapter N needs every quest of chapter N-1 claimed. */
  private chapterUnlocked(book: NewbieQuestBook, index: number, rows: MissionProgressRow[]): boolean {
    if (index <= 0) return true;
    return book.chapters[index - 1].quests.every((quest) => isClaimed(rows, quest.id));
  }

  private targetOf(quest: NewbieQuestConfig): number {
    return quest.kind === "clear_stage" ? 1 : quest.target;
  }

  /** Current progress of a quest (uncapped). */
  private progressOf(quest: NewbieQuestConfig, rows: MissionProgressRow[], facts: FactSnapshot): number {
    switch (quest.kind) {
      case "account_level": return facts.level;
      case "clear_stage": return clearedAtLeast(facts, quest.regionId, quest.stageId, quest.difficulty) ? 1 : 0;
      case "own_monsters": return facts.monsters.get(quest.stars) ?? 0;
      case "rune_level": return facts.runes.get(quest.runeLevel) ?? 0;
      case "equip_runes": return facts.equipped;
      default: return rows.find((row) => row.missionId === counterId(quest.kind))?.progress ?? 0;
    }
  }

  private async loadFacts(userId: string, quests: NewbieQuestConfig[], session?: DbSession): Promise<FactSnapshot> {
    const facts: FactSnapshot = { level: 0, clears: new Map(), monsters: new Map(), runes: new Map(), equipped: 0 };
    const kinds = new Set(quests.map((quest) => quest.kind));
    const { facts: source } = this.deps;
    if (kinds.has("account_level")) facts.level = await source.accountLevel(userId, session);
    if (kinds.has("clear_stage")) {
      for (const clear of await source.stageClears(userId, session)) {
        const rank = STAGE_DIFFICULTIES.indexOf(clear.difficulty);
        const key = stageKey(clear.regionId, clear.stageId);
        facts.clears.set(key, Math.max(facts.clears.get(key) ?? -1, rank));
      }
    }
    for (const quest of quests) {
      if (quest.kind === "own_monsters" && !facts.monsters.has(quest.stars)) facts.monsters.set(quest.stars, await source.countMonsters(userId, quest.stars, session));
      if (quest.kind === "rune_level" && !facts.runes.has(quest.runeLevel)) facts.runes.set(quest.runeLevel, await source.countRunes(userId, quest.runeLevel, session));
    }
    if (kinds.has("equip_runes")) facts.equipped = await source.countEquippedRunes(userId, session);
    return facts;
  }

  private buildState(book: NewbieQuestBook, rows: MissionProgressRow[], facts: FactSnapshot): NewbieQuestStateDto {
    const chapters: NewbieChapterDto[] = book.chapters.map((chapter, index) => {
      const unlocked = this.chapterUnlocked(book, index, rows);
      const quests: NewbieQuestDto[] = chapter.quests.map((quest) => {
        const target = this.targetOf(quest);
        const claimed = isClaimed(rows, quest.id);
        const progress = claimed ? target : Math.min(target, this.progressOf(quest, rows, facts));
        return {
          questId: quest.id,
          kind: quest.kind,
          target,
          progress,
          claimed,
          claimable: unlocked && !claimed && progress >= target,
          rewards: quest.rewards,
          ...(quest.kind === "clear_stage" ? { regionId: quest.regionId, stageId: quest.stageId, difficulty: quest.difficulty } : {}),
          ...(quest.kind === "own_monsters" ? { stars: quest.stars } : {}),
          ...(quest.kind === "rune_level" ? { runeLevel: quest.runeLevel } : {}),
        };
      });
      const claimedCount = quests.filter((quest) => quest.claimed).length;
      const rewardClaimed = isClaimed(rows, chapterClaimId(chapter.id));
      const hasReward = hasRewards(chapter.rewards);
      return {
        chapterId: chapter.id,
        index,
        unlocked,
        claimedCount,
        total: quests.length,
        rewards: chapter.rewards,
        hasReward,
        rewardClaimed,
        rewardClaimable: unlocked && hasReward && !rewardClaimed && claimedCount === quests.length,
        quests,
      };
    });

    const done = (chapter: NewbieChapterDto) => chapter.claimedCount === chapter.total && (!chapter.hasReward || chapter.rewardClaimed);
    const current = chapters.findIndex((chapter) => !done(chapter));
    return {
      ok: true,
      serverTime: this.deps.clock.now().toISOString(),
      completed: current < 0,
      currentChapter: current < 0 ? Math.max(0, chapters.length - 1) : current,
      claimable: chapters.reduce((sum, chapter) => sum + chapter.quests.filter((quest) => quest.claimable).length + (chapter.rewardClaimable ? 1 : 0), 0),
      chapters,
    };
  }

  private async claimResponse(userId: string, grants: ShopGrantsDto): Promise<NewbieQuestClaimDto> {
    if (grants.characters.length > 0) await this.deps.rosterCache.invalidate(userId);
    if (grants.runes.length > 0) await this.deps.runeCache.invalidate(userId);
    return { ...(await this.getState(userId)), grants, wallet: await this.deps.ledger.snapshot(userId) };
  }
}

function isClaimed(rows: MissionProgressRow[], missionId: string): boolean {
  return rows.some((row) => row.missionId === missionId && !!row.claimedAt);
}

function clearedAtLeast(facts: FactSnapshot, regionId: string, stageId: string, difficulty: StageDifficulty): boolean {
  return (facts.clears.get(stageKey(regionId, stageId)) ?? -1) >= STAGE_DIFFICULTIES.indexOf(difficulty);
}
