// Arena use cases outside battles: state (with the running season), defense team, opponent list, defense log and
// ranking.

import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { Clock } from "../../shared/kernel/clock.js";
import type { RandomSource } from "../../shared/kernel/random.js";
import type { WalletSnapshot } from "../../shared/kernel/types.js";
import type { UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import type { ArenaConfig, ArenaNpcRival } from "../../config/ArenaCatalog.js";
import type { WalletLedger } from "../economy/wallet-ledger.js";
import { BattlePveSessionError, validateFormationSlots } from "../battle-pve/BattlePveSessionFactory.js";
import type { CharacterDto } from "../roster/roster.dto.js";
import {
  ARENA_MAX_SLOTS,
  ARENA_WING_CURRENCY,
  npcOpponentId,
  playerOpponentId,
  selectOpponents,
  type ArenaDefense,
  type ArenaOpponentView,
  type ArenaUnitView,
} from "./arena.domain.js";
import type { ArenaCandidate, ArenaProfileRecord, ArenaRepository } from "./arena.ports.js";
import type { ArenaSeasonResult } from "./arena-season.js";
import type { ArenaSeasonService } from "./arena-season.service.js";

/** Candidates fetched per list (nearest ratings first); selection then applies the windows and exclusions. */
const CANDIDATE_POOL = 60;

export type ArenaServiceDeps = {
  arena: ArenaRepository;
  ledger: WalletLedger;
  uow: UnitOfWork;
  clock: Clock;
  random: RandomSource;
  config: () => ArenaConfig;
  /** Owned characters among `uids` (ownership is enforced by the query). */
  loadRoster: (userId: string, uids: string[]) => Promise<CharacterDto[]>;
  /** Element id of a character (null when the character does not exist). */
  characterElement: (characterId: string) => string | null;
  /** Seasons (tiers, season-end rewards, soft reset). Without it the arena has one endless season. */
  seasons?: ArenaSeasonService | null;
};

/** Session-builder errors keep their code as the response error. */
export function asAppError(error: unknown): unknown {
  return error instanceof BattlePveSessionError ? new AppError(error.code, { message: error.message }) : error;
}

export class ArenaService {
  constructor(private readonly deps: ArenaServiceDeps) {}

  /**
   * Rating, record, rank, defense and wings, plus the running season. An ended season is settled first (reward mail,
   * soft reset); `seasonResult` carries that settlement once, so the client can announce it.
   */
  async getState(userId: string) {
    const { arena, uow, ledger } = this.deps;
    const seasons = this.deps.seasons ?? null;
    const cfg = this.deps.config();
    let mailed = false;
    const state = await uow.transaction(async (session) => {
      let profile = await arena.ensureProfile(userId, cfg.startRating, session, !!seasons);
      let seasonResult: ArenaSeasonResult | null = null;
      if (seasons) {
        const outcome = await seasons.rolloverLocked(session, profile);
        profile = outcome.profile;
        mailed = outcome.mailed;
        if (profile.seasonResultPending && profile.lastSeason) {
          seasonResult = profile.lastSeason;
          await arena.markSeasonResultSeen(userId, session);
        }
      }
      const wings = (await ledger.lockedBalances(session, userId, [ARENA_WING_CURRENCY]))[ARENA_WING_CURRENCY] ?? 0;
      return {
        ok: true,
        rating: profile.rating,
        wins: profile.wins,
        losses: profile.losses,
        defenseWins: profile.defenseWins,
        defenseLosses: profile.defenseLosses,
        rank: await arena.rankOf(profile.rating, session),
        defense: profile.defense,
        wings,
        season: seasons?.view(profile) ?? null,
        seasonResult,
      };
    });
    if (mailed) await seasons!.notify([userId]);
    return state;
  }

  /** Stores the defense team after checking that every unit belongs to the player. */
  async setDefense(userId: string, input: ArenaDefense) {
    const { arena, uow } = this.deps;
    let slots;
    try {
      slots = validateFormationSlots(input.uidsInSlots, input.leaderSlotIndex, ARENA_MAX_SLOTS);
    } catch (error) {
      throw asAppError(error);
    }

    const uids = slots.map((slot) => slot.uid);
    const owned = await this.deps.loadRoster(userId, uids);
    if (new Set(owned.map((entry) => entry.uid)).size !== uids.length) throw new AppError(ErrorCode.UNIT_NOT_OWNED);

    const defense: ArenaDefense = { uidsInSlots: input.uidsInSlots.map((uid) => uid.trim()), leaderSlotIndex: input.leaderSlotIndex };
    await uow.transaction(async (session) => {
      await arena.ensureProfile(userId, this.deps.config().startRating, session);
      await arena.saveDefense(userId, defense, session);
    });
    return { ok: true, defense };
  }

  /**
   * Opponent list cached per player. Without `refresh` the cached list is returned (a new one is built when
   * there is none, an attack consumed it or it shows a character the catalog no longer has); `refresh` is free every
   * 10 minutes, otherwise costs `refreshCost`.
   */
  async getOpponents(userId: string, refresh: boolean) {
    const { arena, uow, ledger, clock } = this.deps;
    const cfg = this.deps.config();
    const known = await this.currentProfile(userId);
    if (!refresh && this.isCurrent(known.opponents)) return this.opponentsResponse(known.opponents, known.opponentsRefreshedAt, null);

    // Built outside the transaction (read-only work) and stored under the profile lock.
    const fresh = await this.buildOpponents(userId, known.rating);

    return uow.transaction(async (session) => {
      const profile = await arena.ensureProfile(userId, cfg.startRating, session, true);
      if (!refresh && this.isCurrent(profile.opponents)) return this.opponentsResponse(profile.opponents, profile.opponentsRefreshedAt, null);

      let wallet: WalletSnapshot | null = null;
      const now = clock.nowMs();
      if (refresh) {
        const free = !profile.opponentsRefreshedAt || now - profile.opponentsRefreshedAt.getTime() >= cfg.freeRefreshSeconds * 1000;
        const cost = cfg.refreshCost;
        if (!free) {
          if (!cost) throw new AppError(ErrorCode.ARENA_REFRESH_NOT_AVAILABLE);
          if (cost.amount > 0) {
            wallet = await ledger.debit(session, userId, [cost], { insufficientError: ErrorCode.NOT_ENOUGH_CURRENCY });
          }
        }
      }

      const refreshedAt = refresh ? new Date(now) : undefined;
      await arena.saveOpponents(userId, fresh, refreshedAt, session);
      return this.opponentsResponse(fresh, refreshedAt ?? profile.opponentsRefreshedAt, wallet);
    });
  }

  async getDefenseLog(userId: string) {
    const entries = await this.deps.arena.listDefenseLog(userId, this.deps.config().defenseLogSize);
    return {
      ok: true,
      entries: entries.map((entry) => ({
        attackerName: entry.attackerName,
        defenseWon: entry.defenseWon,
        ratingChange: entry.ratingChange,
        at: entry.at.toISOString(),
      })),
    };
  }

  /** Top `rankingSize` players by rating (ties share the rank) and the player's own rank. */
  async getRanking(userId: string) {
    const { arena } = this.deps;
    const own = await this.currentProfile(userId);
    const rows = await arena.topRatings(this.deps.config().rankingSize);

    let rank = 0;
    const top = rows.map((row, index) => {
      if (index === 0 || row.rating !== rows[index - 1].rating) rank = index + 1;
      return { rank, name: row.name, level: row.level, rating: row.rating, self: row.userId === userId };
    });
    return { ok: true, top, own: { rank: await arena.rankOf(own.rating), rating: own.rating } };
  }

  /** The player's profile, rolled over to the running season first when an ended season was not settled yet. */
  private async currentProfile(userId: string): Promise<ArenaProfileRecord> {
    const profile = await this.deps.arena.ensureProfile(userId, this.deps.config().startRating);
    return this.deps.seasons ? this.deps.seasons.ensureCurrent(userId, profile) : profile;
  }

  /** A cached list is reused only while every unit it shows still exists in the character catalog. */
  private isCurrent(opponents: ArenaOpponentView[] | null | undefined): opponents is ArenaOpponentView[] {
    return !!opponents && opponents.every((opponent) => opponent.units.every((unit) => this.deps.characterElement(unit.characterId) !== null));
  }

  private opponentsResponse(opponents: ArenaOpponentView[], refreshedAt: Date | null, wallet: WalletSnapshot | null) {
    const cost = this.deps.config().refreshCost;
    return {
      ok: true,
      opponents,
      refreshedAt: refreshedAt ? refreshedAt.toISOString() : null,
      nextFreeRefreshAt: new Date((refreshedAt?.getTime() ?? this.deps.clock.nowMs()) + this.deps.config().freeRefreshSeconds * 1000).toISOString(),
      refreshCost: cost ? { currencyId: cost.currencyId, amount: cost.amount } : null,
      ...(wallet ? { wallet } : {}),
    };
  }

  private async buildOpponents(userId: string, rating: number): Promise<ArenaOpponentView[]> {
    const { arena, clock, random } = this.deps;
    const cfg = this.deps.config();
    const recent = await arena.recentDefenderIds(userId, new Date(clock.nowMs() - cfg.recentAttackHideSeconds * 1000));
    const excludeUserIds = new Set([userId, ...recent]);
    const players = await arena.findCandidates(rating, [...excludeUserIds], Math.max(CANDIDATE_POOL, cfg.opponentCount * 10));
    const npcs = cfg.npcRivals.filter((npc) => npc.units.every((unit) => this.deps.characterElement(unit.characterId) !== null));

    const views: ArenaOpponentView[] = [];
    for (const pick of selectOpponents({ rating, players, npcs, excludeUserIds, random, count: cfg.opponentCount, windows: cfg.ratingWindows })) {
      const view = pick.kind === "player" ? await this.playerView(pick.player) : this.npcView(pick.npc);
      if (view.units.length > 0) views.push(view);
    }
    return views;
  }

  private async playerView(candidate: ArenaCandidate): Promise<ArenaOpponentView> {
    const owned = new Map((await this.deps.loadRoster(candidate.userId, candidate.defense.uidsInSlots.filter((uid) => !!uid))).map((entry) => [entry.uid, entry]));
    const units = candidate.defense.uidsInSlots
      .map((uid) => owned.get(uid))
      .filter((entry): entry is CharacterDto => !!entry)
      .map((entry) => this.unitView(entry.characterId, entry.stars, entry.level));
    return { opponentId: playerOpponentId(candidate.publicId), name: candidate.name, rating: candidate.rating, level: candidate.accountLevel, units };
  }

  private npcView(npc: ArenaNpcRival): ArenaOpponentView {
    return {
      opponentId: npcOpponentId(npc.id),
      name: npc.name,
      rating: npc.rating,
      level: Math.max(...npc.units.map((unit) => unit.level)),
      units: npc.units.map((unit) => this.unitView(unit.characterId, unit.star, unit.level)),
    };
  }

  private unitView(characterId: string, star: number, level: number): ArenaUnitView {
    return { characterId, star, level, element: this.deps.characterElement(characterId) ?? "" };
  }
}
