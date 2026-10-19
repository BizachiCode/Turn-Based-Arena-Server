// Arena seasons: the running season, the season block of `arena/state` and the settlement of ended seasons.
//
// Settlement is lazy: every transaction that changes a rating (arena/state, battle settlement for the attacker and a
// real defender) first rolls the locked profile over to the running season, so the rating settled is exactly the
// rating at the end of the season. The sweep job (`ArenaSeasonJob`) settles the players who don't come back, so the
// ranking only shows current-season ratings. A season is settled at most once per player: the rollover is a
// conditional update on the stored season number, and the reward mail carries the receipt key `arena_season:<n>`.

import type { ArenaConfig, ArenaSeasonsConfig } from "../../config/ArenaCatalog.js";
import { emptyPayload } from "../../config/ShopCatalog.js";
import type { AuditLog } from "../../shared/kernel/audit.js";
import type { Clock } from "../../shared/kernel/clock.js";
import type { CurrencyAmount } from "../../shared/kernel/types.js";
import type { DbSession, UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import { createLogger } from "../../shared/logger.js";
import type { MailDraft, MailSendOptions } from "../mail/mail.service.js";
import {
  planSeasonRollover,
  seasonAnchorMs,
  seasonAt,
  softResetRating,
  tierIndexFor,
  tierName,
  tierRewards,
  type ArenaSeasonResult,
  type ArenaSeasonWindow,
} from "./arena-season.js";
import type { ArenaProfileRecord, ArenaRepository } from "./arena.ports.js";

const logger = createLogger("ArenaSeasonService");

/** Season reward mail (translation keys; `{0}` season number, `{1}` tier name, `{2}` final rating). */
export const ARENA_SEASON_MAIL = {
  sender: "Arena",
  titleKey: "text_mail_arena_season_title",
  bodyKey: "text_mail_arena_season_body",
  title: "Arena season {0} rewards",
  body: "Arena season {0} has ended. You finished in the {1} tier with a rating of {2}. Here are your rewards!",
} as const;

/** Mail receipt key of a season's reward (one per player and season). */
export const seasonReceiptKey = (season: number) => `arena_season:${season}`;

/** Mailbox used for the season rewards (implemented by `MailService`). */
export interface ArenaSeasonMailer {
  sendInSession(session: DbSession, userId: string, draft: MailDraft, options?: MailSendOptions): Promise<boolean>;
  notify(userIds: string[]): Promise<void>;
}

export type ArenaSeasonServiceDeps = {
  arena: ArenaRepository;
  uow: UnitOfWork;
  clock: Clock;
  audit: AuditLog;
  config: () => ArenaConfig;
  /** Mailbox for the tier rewards (without one the season is settled but nothing is sent). */
  mail?: ArenaSeasonMailer | null;
};

/** One tier as sent to the client. */
export type ArenaSeasonTierDto = { id: string; name: string; minRating: number; rewards: CurrencyAmount[] };

/** `season` block of `arena/state` (times in unix ms). */
export type ArenaSeasonDto = {
  number: number;
  startsAt: number;
  endsAt: number;
  serverTime: number;
  /** Attacks settled this season and the number needed for the season reward. */
  battles: number;
  minBattles: number;
  tierId: string;
  nextTierId: string | null;
  nextTierMinRating: number | null;
  /** Rating the player would start the next season with (soft reset of the current rating). */
  resetRating: number;
  tiers: ArenaSeasonTierDto[];
};

/** Profile after a rollover; `mailed` = a reward mail was written (push the notice after the commit). */
export type ArenaRolloverOutcome = { profile: ArenaProfileRecord; mailed: boolean };

export class ArenaSeasonService {
  constructor(private readonly deps: ArenaSeasonServiceDeps) {}

  private get seasons(): ArenaSeasonsConfig {
    return this.deps.config().seasons;
  }

  /** The running season (null when seasons are disabled). */
  current(nowMs = this.deps.clock.nowMs()): ArenaSeasonWindow | null {
    const seasons = this.seasons;
    return seasons.enabled ? seasonAt(nowMs, seasonAnchorMs(seasons), seasons.lengthDays) : null;
  }

  /** True when the profile still belongs to another season than the running one. */
  isOutdated(profile: ArenaProfileRecord): boolean {
    const window = this.current();
    return !!window && profile.season !== window.number;
  }

  /**
   * Rolls a profile locked by the caller's transaction over to the running season: settles the ended season (reward
   * mail when the player fought in it, stored result) and applies the soft reset. No-op when it is already current.
   */
  async rolloverLocked(session: DbSession, profile: ArenaProfileRecord): Promise<ArenaRolloverOutcome> {
    const window = this.current();
    if (!window) return { profile, mailed: false };
    const plan = planSeasonRollover(profile, window.number, this.seasons);
    if (!plan) return { profile, mailed: false };

    const nowMs = this.deps.clock.nowMs();
    const settled = plan.settled;
    const rewards = settled?.rewarded ? tierRewards(settled.tier) : [];
    const result: ArenaSeasonResult | undefined = settled?.rewarded
      ? {
        season: settled.season,
        tierId: settled.tier.id,
        rating: settled.rating,
        battles: settled.battles,
        rewards,
        ratingAfter: plan.ratingAfter,
        mailed: rewards.length > 0 && !!this.deps.mail,
        settledAt: nowMs,
      }
      : undefined;

    const moved = await this.deps.arena.rolloverSeason(profile.userId, profile.season, { season: plan.season, rating: plan.ratingAfter, lastSeason: result }, session);
    if (!moved) {
      // Another request settled it meanwhile: continue with the stored profile.
      return { profile: await this.deps.arena.ensureProfile(profile.userId, this.deps.config().startRating, session, true), mailed: false };
    }

    let mailed = false;
    if (settled && result?.mailed) {
      mailed = await this.deps.mail!.sendInSession(session, profile.userId, {
        category: "reward",
        sender: ARENA_SEASON_MAIL.sender,
        titleKey: ARENA_SEASON_MAIL.titleKey,
        bodyKey: ARENA_SEASON_MAIL.bodyKey,
        title: ARENA_SEASON_MAIL.title.replace("{0}", String(settled.season)),
        body: ARENA_SEASON_MAIL.body
          .replace("{0}", String(settled.season))
          .replace("{1}", tierName(settled.tier))
          .replace("{2}", String(settled.rating)),
        params: [settled.season, tierName(settled.tier), settled.rating],
        attachments: { ...emptyPayload(), currencies: rewards.map((entry) => ({ currencyId: entry.currencyId, amount: entry.amount })) },
      }, { receiptKey: seasonReceiptKey(settled.season) });
    }
    if (settled) {
      await this.deps.audit.record({
        userId: profile.userId,
        kind: "ARENA_SEASON",
        meta: { season: settled.season, tierId: settled.tier.id, rating: settled.rating, battles: settled.battles, rewarded: settled.rewarded, rewards, ratingAfter: plan.ratingAfter, mailed },
      }, session);
    }

    return {
      profile: {
        ...profile,
        season: plan.season,
        rating: plan.ratingAfter,
        seasonBattles: 0,
        ...(result ? { lastSeason: result, seasonResultPending: true } : {}),
      },
      mailed,
    };
  }

  /**
   * Settles one player in its own transaction when the profile is outdated (read paths: ranking, opponents).
   * Returns the current profile.
   */
  async ensureCurrent(userId: string, profile?: ArenaProfileRecord): Promise<ArenaProfileRecord> {
    const startRating = this.deps.config().startRating;
    const known = profile ?? await this.deps.arena.ensureProfile(userId, startRating);
    if (!this.isOutdated(known)) return known;

    let mailed = false;
    const fresh = await this.deps.uow.transaction(async (session) => {
      const locked = await this.deps.arena.ensureProfile(userId, startRating, session, true);
      const outcome = await this.rolloverLocked(session, locked);
      mailed = outcome.mailed;
      return outcome.profile;
    });
    if (mailed) await this.notify([userId]);
    return fresh;
  }

  /**
   * Sweep (job): adopts untracked profiles into the running season, then settles every profile still in another
   * season, `batchSize` at a time (one transaction per player). Returns how many profiles were settled.
   */
  async settleOutdatedProfiles(batchSize = 200, maxBatches = 50): Promise<number> {
    const window = this.current();
    if (!window) return 0;
    await this.deps.arena.adoptUntrackedProfiles(window.number);

    let settled = 0;
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const userIds = await this.deps.arena.listOutdatedSeasonUserIds(window.number, batchSize);
      let progressed = 0;
      for (const userId of userIds) {
        try {
          await this.ensureCurrent(userId);
          progressed += 1;
        } catch (error) {
          logger.warn(`season settlement failed for ${userId}:`, (error as Error)?.message ?? error);
        }
      }
      settled += progressed;
      // Done, or only failures left (they are retried by the next run).
      if (userIds.length < batchSize || progressed === 0) break;
    }
    return settled;
  }

  /** Season block of `arena/state` for a current profile (null when seasons are disabled). */
  view(profile: ArenaProfileRecord): ArenaSeasonDto | null {
    const nowMs = this.deps.clock.nowMs();
    const window = this.current(nowMs);
    if (!window) return null;
    const seasons = this.seasons;
    const index = tierIndexFor(profile.rating, seasons.tiers);
    const next = seasons.tiers[index + 1] ?? null;
    return {
      number: window.number,
      startsAt: window.startsAt,
      endsAt: window.endsAt,
      serverTime: nowMs,
      battles: profile.season === window.number ? profile.seasonBattles : 0,
      minBattles: seasons.minBattles,
      tierId: seasons.tiers[index].id,
      nextTierId: next ? next.id : null,
      nextTierMinRating: next ? next.minRating : null,
      resetRating: softResetRating(profile.rating, seasons.reset),
      tiers: seasons.tiers.map((entry) => ({ id: entry.id, name: tierName(entry), minRating: entry.minRating, rewards: tierRewards(entry) })),
    };
  }

  /** Pushes the "new mail" notice after the commit (best effort). */
  async notify(userIds: string[]): Promise<void> {
    if (userIds.length === 0 || !this.deps.mail) return;
    try {
      await this.deps.mail.notify(userIds);
    } catch (error) {
      logger.warn("season mail push failed:", (error as Error)?.message ?? error);
    }
  }
}
