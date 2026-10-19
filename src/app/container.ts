// Composition root: builds infrastructure adapters, repositories, services and room bindings.
// Colyseus instantiates rooms itself, so rooms receive their dependencies through `bindRoom()`.

import type Redis from "ioredis";
import { matchMaker } from "@colyseus/core";

import { env, type Env } from "../config/env.js";
import {
  capacityDefaults,
  characterRules,
  chatRules,
  currencyRules,
  homeRules,
  iconRules,
  mapRules,
  nicknameRules,
  runeRules,
  skillUpRules,
  summonRules,
} from "../config/catalog-rules.js";
import { RedisCache } from "../infrastructure/cache/redis-cache.js";
import { RedisSessionStore } from "../infrastructure/cache/session.cache.js";
import type { Database } from "../infrastructure/database/drizzle.js";
import { DrizzleUnitOfWork } from "../infrastructure/database/drizzle-unit-of-work.js";
import { DrizzleAuditLog } from "../infrastructure/database/audit-log.js";
import { DrizzleLogStore } from "../infrastructure/logging/drizzle-log-store.js";
import { DrizzleRequestResultStore } from "../modules/idempotency/request-results.repository.js";
import { Idempotency } from "../shared/kernel/idempotency.js";
import { notifyUserRevoked } from "../shared/rooms/user-revocation.js";
import { AdminLogsService } from "../modules/admin/admin-logs.service.js";
import { DrizzleAdminLogsRepository } from "../modules/admin/admin-logs.repository.js";
import { logSink } from "../shared/log/log-sink.js";
import { AccountPurgeJob } from "../infrastructure/maintenance/account-purge.job.js";
import { ArenaSeasonJob } from "../infrastructure/maintenance/arena-season.job.js";
import { RetentionJob } from "../infrastructure/maintenance/retention.job.js";
import type { ServerRuntimeState } from "../infrastructure/runtime/server-runtime-state.js";
import { PlayerActivityHub } from "../shared/kernel/activity.js";
import { systemClock, type Clock } from "../shared/kernel/clock.js";
import { cryptoRandom, type RandomSource } from "../shared/kernel/random.js";
import { AccessAuthenticator } from "../shared/security/access-authenticator.js";
import { Argon2PasswordHasher, Sha256RefreshTokenHasher } from "../shared/security/password-hasher.js";
import { TokenBucketRateLimiter, type RateLimiter } from "../shared/security/rate-limiter.js";
import { RedisRateLimiter } from "../infrastructure/cache/redis-rate-limiter.js";
import { JwtAccessTokenService } from "../shared/security/token-service.js";
import { bindRoom } from "../shared/rooms/base-room.js";

import { AccountRoom } from "../modules/account/account.room.js";
import { AccountService } from "../modules/account/account.service.js";
import { DrizzleAdminUserDirectory } from "../modules/admin/admin.repository.js";
import { DrizzleAdminPlayerRepository } from "../modules/admin/admin-players.repository.js";
import { AdminPlayersService } from "../modules/admin/admin-players.service.js";
import { AdminPlayerEditsService } from "../modules/admin/admin-player-edits.service.js";
import { AdminAnalyticsService } from "../modules/admin/admin-analytics.service.js";
import { DrizzleAdminAnalyticsRepository } from "../modules/admin/admin-analytics.repository.js";
import { AdminGuildsService } from "../modules/admin/admin-guilds.service.js";
import { DrizzleAdminGuildRepository } from "../modules/admin/admin-guilds.repository.js";
import { AdminReportsService } from "../modules/admin/admin-reports.service.js";
import { DrizzleAdminReportRepository } from "../modules/admin/admin-reports.repository.js";
import { ChatTextFilter } from "../modules/chat/chat-text-filter.js";
import { DrizzleReportRepository } from "../modules/report/report.repository.js";
import { ReportService } from "../modules/report/report.service.js";
import { getChatFilterConfigFromConfig, getReportRulesFromConfig } from "../config/LiveConfigCatalog.js";
import { AdminModerationService } from "../modules/admin/admin-moderation.service.js";
import { DrizzleAdminModerationRepository } from "../modules/admin/admin-moderation.repository.js";
import { AdminConfigService } from "../modules/admin/admin-config.service.js";
import { RuntimeGrantsService } from "../modules/admin/runtime-grants.service.js";
import { DrizzleAuthRepository } from "../modules/auth/auth.repository.js";
import { ArenaBattleService } from "../modules/arena/arena-battle.service.js";
import { ArenaSeasonService } from "../modules/arena/arena-season.service.js";
import { ArenaSessionFactory } from "../modules/arena/arena-session.factory.js";
import { DrizzleArenaRepository } from "../modules/arena/arena.repository.js";
import { ArenaRoom } from "../modules/arena/arena.room.js";
import { ArenaService } from "../modules/arena/arena.service.js";
import { AuthRoom } from "../modules/auth/auth.room.js";
import { AuthService } from "../modules/auth/auth.service.js";
import { AwakeningRoom } from "../modules/awakening/awakening.room.js";
import { AwakeningService } from "../modules/awakening/awakening.service.js";
import { BattlePveRoom } from "../modules/battle-pve/battle-pve.room.js";
import { BattlePvpRoom, PVP_PLAYER_BUSY } from "../modules/battle-pvp/battle-pvp.room.js";
import { PvpSessionFactory } from "../modules/battle-pvp/pvp-session.factory.js";
import { signMatchTicket } from "../modules/battle-pvp/pvp-ticket.js";
import { DrizzleDmRepository } from "../modules/social/dm.repository.js";
import { DrizzleFriendlyMatchRepository } from "../modules/social/friendly.repository.js";
import { FriendlyBattleService, FriendlyRoomBusyError } from "../modules/social/friendly.service.js";
import { DmService } from "../modules/social/dm.service.js";
import { FriendsService } from "../modules/social/friends.service.js";
import { PlayerStatusReader } from "../modules/social/player-status.js";
import { SocialRoom } from "../modules/social/social.room.js";
import { DrizzleSocialRepository } from "../modules/social/social.repository.js";
import type { SocialNotifier } from "../modules/social/social.ports.js";
import { type ActiveBattleRegistry, createColyseusActiveBattleRegistry } from "../shared/rooms/active-battles.js";
import { DrizzlePveBattleRepository } from "../modules/battle-pve/battle-pve.repository.js";
import { BattlePveService } from "../modules/battle-pve/battle-pve.service.js";
import { BattleRewardService } from "../modules/battle-pve/battle-rewards.service.js";
import { AccountProgressionService } from "../modules/progression/account-progression.service.js";
import { BattlePveSessionFactory } from "../modules/battle-pve/BattlePveSessionFactory.js";
import { CatalogService } from "../modules/catalog/catalog.service.js";
import { ChatDirectoryRoom } from "../modules/chat/chat-directory.room.js";
import { ChatOccupancy } from "../modules/chat/chat.occupancy.js";
import { DrizzleChatRepository } from "../modules/chat/chat.repository.js";
import { ChatRoom } from "../modules/chat/chat.room.js";
import { ChatService } from "../modules/chat/chat.service.js";
import { CachedGmMuteSource } from "../modules/chat/gm-mute.source.js";
import { PresenceGuildChatFanout } from "../modules/chat/guild-chat.fanout.js";
import { DrizzleGuildChatRepository } from "../modules/chat/guild-chat.repository.js";
import { GuildChatRoom } from "../modules/chat/guild-chat.room.js";
import { GuildChatService, guildChatMembershipOf } from "../modules/chat/guild-chat.service.js";
import { DrizzleWalletRepository } from "../modules/economy/economy.repository.js";
import { EconomyRoom } from "../modules/economy/economy.room.js";
import { EconomyService } from "../modules/economy/economy.service.js";
import { WalletLedger } from "../modules/economy/wallet-ledger.js";
import { DrizzleBuildingInventoryRepository } from "../modules/home/building-inventory.repository.js";
import { DrizzleHomeProductionRepository } from "../modules/home/home-production.repository.js";
import { DrizzleGuildQuestRepository } from "../modules/guild/guild-quest.repository.js";
import { GuildQuestService } from "../modules/guild/guild-quest.service.js";
import { DrizzleGuildRepository } from "../modules/guild/guild.repository.js";
import { GuildRoom } from "../modules/guild/guild.room.js";
import { GuildService } from "../modules/guild/guild.service.js";
import { DrizzleMailRepository } from "../modules/mail/mail.repository.js";
import { MailRoom } from "../modules/mail/mail.room.js";
import { MailService } from "../modules/mail/mail.service.js";
import { RewardGranter } from "../modules/rewards/reward-granter.js";
import { DrizzleStoryRepository } from "../modules/story/story.repository.js";
import { StoryRoom } from "../modules/story/story.room.js";
import { StoryService } from "../modules/story/story.service.js";
import { DrizzleHomeRepository } from "../modules/home/home.repository.js";
import { HomeRoom } from "../modules/home/home.room.js";
import { HomeService } from "../modules/home/home.service.js";
import { DrizzleMapProgressRepository } from "../modules/map/map.repository.js";
import { MapRoom } from "../modules/map/map.room.js";
import { MapService } from "../modules/map/map.service.js";
import { DrizzlePresenceRepository } from "../modules/presence/presence.repository.js";
import { PresenceRoom } from "../modules/presence/presence.room.js";
import { PresenceService } from "../modules/presence/presence.service.js";
import { DrizzleProfileRepository } from "../modules/profile/profile.repository.js";
import { ProfileRoom } from "../modules/profile/profile.room.js";
import { ProfileService } from "../modules/profile/profile.service.js";
import { liveProgressionRules } from "../modules/progression/live-progression-rules.js";
import { MonsterProgression } from "../modules/progression/progression.rules.js";
import { CharacterGrantService } from "../modules/roster/character-grant.service.js";
import { RosterCache } from "../modules/roster/roster.cache.js";
import { toCharacterDtoList } from "../modules/roster/roster.mapper.js";
import { DrizzleCharacterRepository } from "../modules/roster/roster.repository.js";
import { RosterRoom } from "../modules/roster/roster.room.js";
import { RosterService } from "../modules/roster/roster.service.js";
import { RuneCache } from "../modules/rune/rune.cache.js";
import { RuneGenerator } from "../modules/rune/rune.generator.js";
import { toRuneDto } from "../modules/rune/rune.mapper.js";
import { DrizzleRuneRepository } from "../modules/rune/rune.repository.js";
import { RuneRoom } from "../modules/rune/rune.room.js";
import { RuneService } from "../modules/rune/rune.service.js";
import { SummonRoom } from "../modules/summon/summon.room.js";
import { DrizzleShopRepository } from "../modules/shop/shop.repository.js";
import { ShopRoom } from "../modules/shop/shop.room.js";
import { ShopService } from "../modules/shop/shop.service.js";
import type { IapReceiptValidator } from "../modules/shop/iap/iap.ports.js";
import { StoreIapReceiptValidator } from "../modules/shop/iap/iap-receipt-validator.js";
import { GooglePlayVerifier, loadGoogleServiceAccount, type GoogleServiceAccount } from "../modules/shop/iap/google-play.verifier.js";
import { AppleAppStoreVerifier, loadAppleRootCertificates } from "../modules/shop/iap/apple-app-store.verifier.js";
import { DrizzleIapTransactionRepository } from "../modules/shop/iap/iap.repository.js";
import { getArenaConfig, loadArenaConfigOnce, reloadArenaConfigFromFile } from "../config/ArenaCatalog.js";
import { getCharacterById } from "../config/CharacterCatalog.js";
import { getGuildConfig, loadGuildConfigOnce, reloadGuildConfigFromFile } from "../config/GuildCatalog.js";
import { getMailConfig, loadMailConfigOnce, reloadMailConfigFromFile } from "../config/MailCatalog.js";
import { getSocialConfig, loadSocialConfigOnce, reloadSocialConfigFromFile } from "../config/SocialCatalog.js";
import { getDungeonConfig, loadDungeonConfigOnce, reloadDungeonConfigFromFile } from "../config/DungeonCatalog.js";
import { getAccountExpFromConfig, getRosterRulesFromConfig, getStageStartTicketMinutesFromConfig } from "../config/LiveConfigCatalog.js";
import { getMissionConfig, loadMissionConfigOnce, reloadMissionConfigFromFile } from "../config/MissionCatalog.js";
import { getTowerCatalog, loadTowerCatalogOnce, reloadTowerCatalogFromFile } from "../config/TowerCatalog.js";
import { composeGates } from "../modules/map/map.ports.js";
import { DrizzleTowerProgressRepository } from "../modules/tower/tower.repository.js";
import { TowerService } from "../modules/tower/tower.service.js";
import { storyRegions } from "../config/MapCatalog.js";
import { getRankingConfig, loadRankingConfigOnce, reloadRankingConfigFromFile } from "../config/RankingCatalog.js";
import { DrizzleRankingRepository } from "../modules/ranking/ranking.repository.js";
import { RankingRoom } from "../modules/ranking/ranking.room.js";
import { RankingService } from "../modules/ranking/ranking.service.js";
import { DrizzleMissionRepository } from "../modules/missions/missions.repository.js";
import { MissionsRoom } from "../modules/missions/missions.room.js";
import { MissionService } from "../modules/missions/missions.service.js";
import { getAttendanceConfig, loadAttendanceConfigOnce, reloadAttendanceConfigFromFile } from "../config/AttendanceCatalog.js";
import { DrizzleAttendanceRepository } from "../modules/missions/attendance.repository.js";
import { AttendanceService } from "../modules/missions/attendance.service.js";
import { getNewbieQuestBook, loadNewbieQuestBookOnce, reloadNewbieQuestBookFromFile } from "../config/NewPlayerQuestCatalog.js";
import { DrizzleNewbieQuestCounts } from "../modules/missions/newbie-quests.repository.js";
import { NewbieQuestService } from "../modules/missions/newbie-quests.service.js";
import { DungeonService } from "../modules/dungeon/dungeon.service.js";
import { getStoryCatalog, getStoryDialogue, loadStoryCatalogOnce, reloadStoryCatalogFromFile } from "../config/StoryCatalog.js";
import { getShopCatalog, getShopItemById, loadShopCatalogOnce, reloadShopCatalogFromFile } from "../config/ShopCatalog.js";
import { SummonService } from "../modules/summon/summon.service.js";
import { DrizzleSummonCounterRepository } from "../modules/summon/summon.repository.js";

export type ContainerOptions = {
  database: Database;
  redis: Redis;
  runtime: ServerRuntimeState;
  env?: Env;
  clock?: Clock;
  random?: RandomSource;
  /**
   * Real-money receipt validation (shop items priced as RealMoneyIAP). Default: Google Play + App Store + Demo
   * (`createIapValidator`); null turns real-money items off.
   */
  iapValidator?: IapReceiptValidator | null;
  /** One live battle per player (default: Colyseus presence + matchmaking driver). */
  activeBattles?: ActiveBattleRegistry;
};

/** Bucket sizes shared by both limiter stores. */
const RATE_LIMITS = {
  /** Credential attempts per IP. */
  auth: { tokensPerInterval: 10, intervalMs: 10_000, burst: 15 },
  /** Read-only requests per user. */
  query: { tokensPerInterval: 60, intervalMs: 10_000, burst: 60 },
  /** State-changing requests per user. */
  mutation: { tokensPerInterval: 30, intervalMs: 10_000, burst: 30 },
  /** Battle steps per user. */
  battle: { tokensPerInterval: 40, intervalMs: 10_000, burst: 40 },
  /** Account management (password checks, device revocation, deletion) per user. */
  account: { tokensPerInterval: 5, intervalMs: 30_000, burst: 5 },
  /** Every authenticated request per IP (several accounts behind one address). */
  ip: { tokensPerInterval: 200, intervalMs: 10_000, burst: 200 },
  /** Room joins (seat reservations) per user: a client opens ~21 rooms at login, two devices ~42. */
  join: { tokensPerInterval: 30, intervalMs: 10_000, burst: 90 },
  /** Guild chat lines per user (same size as the default chat rules; the chat service applies the live rules). */
  chatSend: { tokensPerInterval: 8, intervalMs: 10_000, burst: 12 },
} as const;

/**
 * Rate limiters shared by every room (keyed by user id, or IP for anonymous rooms). In memory by default; pass a
 * Redis client (RATE_LIMIT_STORE=redis) so several server processes share the same buckets.
 */
export function createRateLimiters(redis?: Redis): Record<keyof typeof RATE_LIMITS, RateLimiter> {
  const make = (name: keyof typeof RATE_LIMITS): RateLimiter =>
    redis ? new RedisRateLimiter(redis, name, RATE_LIMITS[name]) : new TokenBucketRateLimiter(RATE_LIMITS[name]);
  return {
    auth: make("auth"),
    query: make("query"),
    mutation: make("mutation"),
    battle: make("battle"),
    account: make("account"),
    ip: make("ip"),
    chatSend: make("chatSend"),
    join: make("join"),
  };
}

/**
 * Default real-money stores: Google Play (service account from the `.env`), App Store (Apple root certificates in
 * `certs/apple`) and Demo. Credentials are read on the first purchase, so a server without them still boots.
 */
export function createIapValidator(config: Env): StoreIapReceiptValidator {
  let account: GoogleServiceAccount | null | undefined;
  let appleRoots: Buffer[] | undefined;
  return new StoreIapReceiptValidator([
    new GooglePlayVerifier(() => (account === undefined
      ? (account = loadGoogleServiceAccount(config.iap.googleServiceAccountJson, config.iap.googleServiceAccountFile))
      : account)),
    new AppleAppStoreVerifier(() => (appleRoots ??= loadAppleRootCertificates(config.iap.appleRootCertsDir)), config.iap.appleOnlineChecks),
  ], config.iap.demoPurchases);
}

export function createContainer(options: ContainerOptions) {
  const config = options.env ?? env;
  const clock = options.clock ?? systemClock;
  const random = options.random ?? cryptoRandom;
  const { database, redis, runtime } = options;

  // ── Infrastructure ──────────────────────────────────────────────────
  const uow = new DrizzleUnitOfWork(database);
  const cache = new RedisCache(redis);
  const sessions = new RedisSessionStore(redis, config.accessTtlMin);
  const tokens = new JwtAccessTokenService(config.jwtAccessSecret, config.accessTtlMin);
  const authenticator = new AccessAuthenticator(tokens, sessions);
  const limiters = createRateLimiters(config.rateLimitStore === "redis" ? redis : undefined);
  const audit = new DrizzleAuditLog(database);
  /** Stored responses of idempotent requests (`requestId`), written in the mutation's transaction. */
  const idempotency = new Idempotency(new DrizzleRequestResultStore(database), uow);
  /** Server logs: the sink persists to `server_logs` (attached in `beforeListen`); the GM panel reads them back. */
  const logStore = new DrizzleLogStore(database);

  // ── Repositories ────────────────────────────────────────────────────
  const wallets = new DrizzleWalletRepository(database);
  const profilesRepo = new DrizzleProfileRepository(database);
  const usersRepo = new DrizzleAuthRepository(database);
  const characters = new DrizzleCharacterRepository(database);
  const runesRepo = new DrizzleRuneRepository(database);
  const mapProgress = new DrizzleMapProgressRepository(database);
  const homesRepo = new DrizzleHomeRepository(database);
  const buildingInventory = new DrizzleBuildingInventoryRepository(database);
  const homeProductions = new DrizzleHomeProductionRepository(database);
  const chatRepo = new DrizzleChatRepository(database);
  const presenceRepo = new DrizzlePresenceRepository(database);
  const adminUsers = new DrizzleAdminUserDirectory(database);
  const adminPlayersRepo = new DrizzleAdminPlayerRepository(database);
  const pveBattles = new DrizzlePveBattleRepository(database);

  // ── Application services ────────────────────────────────────────────
  /** Gameplay activity (stage clears, summons...) published after each commit; the guild quests subscribe below. */
  const activity = new PlayerActivityHub();
  const progression = new MonsterProgression(liveProgressionRules);
  const ledger = new WalletLedger(wallets, currencyRules, clock);
  const economy = new EconomyService(wallets, ledger, currencyRules, uow, clock);
  /** Chat word filter (`config.json > chat > filter`): chat lines (mask / block), nicknames and guild texts (block). */
  const textFilter = new ChatTextFilter(getChatFilterConfigFromConfig, clock);
  const profiles = new ProfileService(profilesRepo, iconRules, nicknameRules, random, textFilter);
  const passwordHasher = new Argon2PasswordHasher(config.passwordPepper);
  const auth = new AuthService(
    usersRepo,
    profiles,
    economy,
    sessions,
    tokens,
    passwordHasher,
    new Sha256RefreshTokenHasher(config.refreshPepper),
    uow,
    clock,
    { refreshTtlDays: config.refreshTtlDays, onSessionsRevoked: notifyUserRevoked },
  );
  const accounts = new AccountService(usersRepo, passwordHasher, sessions, uow, clock, {
    deletionGraceDays: config.accountDeletionGraceDays,
    onSessionsRevoked: notifyUserRevoked,
  });

  const rosterCache = new RosterCache(cache);
  const arenaDefenses = new DrizzleArenaRepository(database);
  const roster = new RosterService(characters, rosterCache, ledger, progression, capacityDefaults, uow, activity, skillUpRules, random, {
    rules: getRosterRulesFromConfig,
    reserved: {
      reservedUids: async (userId, session) => new Set((await arenaDefenses.findDefense(userId, session))?.uidsInSlots.filter((uid) => !!uid) ?? []),
    },
  }, idempotency);
  const characterGrants = new CharacterGrantService(characters, characterRules, progression, capacityDefaults);

  const runeCache = new RuneCache(cache);
  const runeGenerator = new RuneGenerator(runeRules, random);
  const runes = new RuneService(runesRepo, runeGenerator, runeRules, ledger, runeCache, uow, activity, idempotency);

  const summons = new SummonService(summonRules, currencyRules, characterRules, characterGrants, ledger, rosterCache, random, uow, activity, clock,
    new DrizzleSummonCounterRepository(database), idempotency);
  const awakening = new AwakeningService(characters, characterRules, ledger, rosterCache, uow, activity, idempotency);
  const dungeons = new DungeonService({
    config: getDungeonConfig,
    maps: mapRules,
    accountLevel: async (userId) => (await profilesRepo.findByUserId(userId))?.level ?? 1,
    clock,
  });
  const towers = new TowerService({
    config: getTowerCatalog,
    maps: mapRules,
    progress: new DrizzleTowerProgressRepository(database),
    accountLevel: async (userId) => (await profilesRepo.findByUserId(userId))?.level ?? 1,
    clock,
  });
  const maps = new MapService(mapProgress, mapRules, characters, ledger, economy, pveBattles, uow, composeGates(dungeons, towers), activity, idempotency);
  auth.addSnapshotExtension(async (userId) => ({ mapProgress: await maps.listProgress(userId) }));
  const homes = new HomeService(
    homesRepo,
    buildingInventory,
    homeRules,
    ledger,
    async (userId, session) => (await profilesRepo.findByUserId(userId, session))?.level ?? 1,
    uow,
    clock,
    homeProductions,
    characters,
    progression,
    rosterCache,
  );
  /** GM chat mutes (`users.chat_muted_until`), cached briefly; the GM panel invalidates it on mute/unmute. */
  const gmMutes = new CachedGmMuteSource((userId) => adminPlayersRepo.chatMutedUntil(userId), clock);
  const chat = new ChatService(chatRepo, new ChatOccupancy(), async (userId) => {
    const profile = await profiles.getProfile(userId);
    return profile ? { nickname: profile.name, iconId: profile.iconId, level: profile.level } : null;
  }, chatRules, clock, gmMutes.untilUnix, textFilter);
  const presence = new PresenceService(presenceRepo);

  const battleSessionSources = {
    loadRoster: async (userId: string, uids: string[]) => toCharacterDtoList(await characters.listByUids(userId, uids)),
    loadEquippedRunes: async (userId: string, uids: string[]) => (await runes.listEquippedOn(userId, uids)).map(toRuneDto),
  };
  const battleSessions = new BattlePveSessionFactory(battleSessionSources);

  const accountProgression = new AccountProgressionService(profilesRepo, ledger, currencyRules, getAccountExpFromConfig);
  const battleRewards = new BattleRewardService(pveBattles, mapProgress, mapRules, ledger, characters, progression, runes, rosterCache, runeCache, random, uow, clock, audit, activity, accountProgression, towers);
  const battles = new BattlePveService(battleSessions, pveBattles, battleRewards, uow, clock, getStageStartTicketMinutesFromConfig);

  // ── Rewards and mailbox ─────────────────────────────────────────────
  const rewards = new RewardGranter({
    ledger,
    characters,
    characterGrants,
    runes,
    constructions: homes,
    scrolls: summonRules,
    currencies: currencyRules,
  });
  const mail = new MailService({
    mail: new DrizzleMailRepository(database),
    rewards,
    ledger,
    rosterCache,
    runeCache,
    audit,
    uow,
    clock,
    config: getMailConfig,
    notifier: {
      mailChanged: async (userId) => { await runtime.pushMailNotice(userId); },
      mailBroadcast: () => runtime.broadcastMailNotice(),
    },
  });

  // ── Arena (season rewards are mailed) ───────────────────────────────
  const arenaRepo = new DrizzleArenaRepository(database);
  const arenaSeasons = new ArenaSeasonService({ arena: arenaRepo, uow, clock, audit, config: getArenaConfig, mail });
  const arena = new ArenaService({
    arena: arenaRepo,
    ledger,
    uow,
    clock,
    random,
    config: getArenaConfig,
    loadRoster: async (userId, uids) => toCharacterDtoList(await characters.listByUids(userId, uids)),
    characterElement: (characterId) => {
      const character = getCharacterById(characterId);
      return character ? character.element ?? "" : null;
    },
    seasons: arenaSeasons,
  });
  const arenaBattles = new ArenaBattleService({
    arena: arenaRepo,
    sessions: new ArenaSessionFactory(battleSessionSources),
    ledger,
    uow,
    clock,
    audit,
    config: getArenaConfig,
    activity,
    seasons: arenaSeasons,
  });

  // ── Story / tutorial ────────────────────────────────────────────────
  const story = new StoryService({
    story: new DrizzleStoryRepository(database),
    rewards,
    ledger,
    rosterCache,
    runeCache,
    audit,
    uow,
    clock,
    catalog: getStoryCatalog,
    lookup: getStoryDialogue,
  });

  // ── Daily missions / achievements ───────────────────────────────────
  const missions = new MissionService({
    missions: new DrizzleMissionRepository(database),
    rewards,
    ledger,
    rosterCache,
    runeCache,
    audit,
    uow,
    clock,
    config: getMissionConfig,
    accountLevel: async (userId, session) => (await profilesRepo.findByUserId(userId, session))?.level ?? 1,
  });
  activity.subscribe(missions);
  const newbieCounts = new DrizzleNewbieQuestCounts(database);
  const newbieQuests = new NewbieQuestService({
    missions: new DrizzleMissionRepository(database),
    facts: {
      accountLevel: async (userId, session) => (await profilesRepo.findByUserId(userId, session))?.level ?? 1,
      stageClears: (userId, session) => mapProgress.listProgress(userId, session),
      countMonsters: (userId, minStars, session) => newbieCounts.countMonsters(userId, minStars, session),
      countRunes: (userId, minLevel, session) => newbieCounts.countRunes(userId, minLevel, session),
      countEquippedRunes: (userId, session) => newbieCounts.countEquippedRunes(userId, session),
    },
    rewards,
    ledger,
    rosterCache,
    runeCache,
    audit,
    uow,
    clock,
    config: getNewbieQuestBook,
  });
  activity.subscribe(newbieQuests);
  const attendance = new AttendanceService({
    attendance: new DrizzleAttendanceRepository(database),
    rewards,
    ledger,
    rosterCache,
    runeCache,
    audit,
    uow,
    clock,
    config: getAttendanceConfig,
  });

  // ── Guilds ──────────────────────────────────────────────────────────
  const guildRepo = new DrizzleGuildRepository(database);
  /** Guild chat: membership read from `guild_members`; lines fanned out to the `guild_chat` rooms through the presence. */
  const guildChat = new GuildChatService({
    repo: new DrizzleGuildChatRepository(database),
    membership: guildChatMembershipOf(guildRepo),
    chat,
    fanout: new PresenceGuildChatFanout(() => matchMaker.presence),
    clock,
  });
  const guilds = new GuildService({ guilds: guildRepo, ledger, uow, clock, config: getGuildConfig, mail, events: guildChat, textGuard: textFilter });
  /** Player reports (`report_player` in the presence room); chat evidence is copied from the stored history. */
  const guildMembership = guildChatMembershipOf(guildRepo);
  const reports = new ReportService({
    repo: new DrizzleReportRepository(database),
    uow,
    clock,
    rules: getReportRulesFromConfig,
    guildOf: async (userId) => (await guildMembership.guildOf(userId))?.guildId ?? null,
  });
  accounts.addPurgeHook((userIds, session) => guilds.removeAccounts(userIds, session));
  const guildQuests = new GuildQuestService({
    quests: new DrizzleGuildQuestRepository(database),
    guilds: guildRepo,
    rewards,
    ledger,
    rosterCache,
    runeCache,
    audit,
    uow,
    clock,
    config: getGuildConfig,
  });
  activity.subscribe(guildQuests);

  const shop = new ShopService({
    shop: new DrizzleShopRepository(database),
    catalog: { catalog: getShopCatalog, get: getShopItemById },
    ledger,
    characters,
    characterGrants,
    runes,
    constructions: homes,
    progress: mapProgress,
    scrolls: summonRules,
    currencies: currencyRules,
    accountLevel: async (userId, session) => (await profilesRepo.findByUserId(userId, session))?.level ?? 1,
    iap: options.iapValidator === undefined ? createIapValidator(config) : options.iapValidator,
    iapTransactions: new DrizzleIapTransactionRepository(database),
    rosterCache,
    runeCache,
    audit,
    uow,
    clock,
  });

  const catalogs = new CatalogService(config.configDir);
  catalogs.register({ fileName: "shop.json", loadOnce: loadShopCatalogOnce, reloadFromFile: reloadShopCatalogFromFile });
  catalogs.register({ fileName: "arena.json", loadOnce: loadArenaConfigOnce, reloadFromFile: reloadArenaConfigFromFile });
  catalogs.register({ fileName: "guild.json", loadOnce: loadGuildConfigOnce, reloadFromFile: reloadGuildConfigFromFile });
  catalogs.register({ fileName: "mail.json", loadOnce: loadMailConfigOnce, reloadFromFile: reloadMailConfigFromFile });
  catalogs.register({ fileName: "dungeons.json", loadOnce: loadDungeonConfigOnce, reloadFromFile: reloadDungeonConfigFromFile });
  catalogs.register({ fileName: "missions.json", loadOnce: loadMissionConfigOnce, reloadFromFile: reloadMissionConfigFromFile });
  catalogs.register({ fileName: "towers.json", loadOnce: loadTowerCatalogOnce, reloadFromFile: reloadTowerCatalogFromFile });
  catalogs.register({ fileName: "new_player_quests.json", loadOnce: loadNewbieQuestBookOnce, reloadFromFile: reloadNewbieQuestBookFromFile });
  catalogs.register({ fileName: "attendance.json", loadOnce: loadAttendanceConfigOnce, reloadFromFile: reloadAttendanceConfigFromFile });
  catalogs.register({ fileName: "dialogues.json", loadOnce: loadStoryCatalogOnce, reloadFromFile: reloadStoryCatalogFromFile });
  catalogs.register({ fileName: "ranking.json", loadOnce: loadRankingConfigOnce, reloadFromFile: reloadRankingConfigFromFile });
  catalogs.register({ fileName: "social.json", loadOnce: loadSocialConfigOnce, reloadFromFile: reloadSocialConfigFromFile });
  const grants = new RuntimeGrantsService(
    adminUsers,
    economy,
    ledger,
    currencyRules,
    characterGrants,
    rosterCache,
    runes,
    runeRules,
    runeCache,
    runtime,
    audit,
    uow,
  );
  const adminPlayers = new AdminPlayersService({
    users: adminUsers,
    players: adminPlayersRepo,
    accounts: usersRepo,
    sessions,
    disconnector: runtime,
    economy,
    ledger,
    currencies: currencyRules,
    profiles: profilesRepo,
    notifier: runtime,
    audit,
    uow,
    clock,
    maxAccountLevel: () => getAccountExpFromConfig().maxLevel,
    knownDialogue: (dialogueId) => !!getStoryDialogue(dialogueId) || getStoryCatalog().allowUnknownDialogues,
    onMuteChanged: (userId) => gmMutes.invalidate(userId),
  });
  const adminEdits = new AdminPlayerEditsService({
    users: adminUsers,
    nicknames: profiles,
    mail,
    guilds,
    characters,
    runes: runesRepo,
    progression,
    reserved: {
      reservedUids: async (userId, session) => new Set((await arenaDefenses.findDefense(userId, session))?.uidsInSlots.filter((uid) => !!uid) ?? []),
    },
    invalidateRoster: (userId) => rosterCache.invalidate(userId),
    invalidateRunes: (userId) => runeCache.invalidate(userId),
    audit,
    uow,
  });
  const adminAnalytics = new AdminAnalyticsService({ repo: new DrizzleAdminAnalyticsRepository(database), clock });
  const adminGuilds = new AdminGuildsService({ repo: new DrizzleAdminGuildRepository(database), guilds, audit });
  const adminModeration = new AdminModerationService({
    repo: new DrizzleAdminModerationRepository(database),
    audit,
    clock,
    chatFilter: textFilter,
    users: adminUsers,
  });
  const adminReports = new AdminReportsService({
    repo: new DrizzleAdminReportRepository(database),
    sanctions: adminPlayers,
    warnings: adminEdits,
    mailer: mail,
    users: adminUsers,
    audit,
    clock,
    rules: getReportRulesFromConfig,
  });
  const adminConfig = new AdminConfigService(config.configDir);
  const adminLogs = new AdminLogsService({ repo: new DrizzleAdminLogsRepository(database), sink: logSink, clock, retentionDays: config.logRetentionDays });
  const retention = new RetentionJob(database, {
    refreshLogDays: config.retentionTokenDays,
    auditDays: config.retentionAuditDays,
    exportDir: config.logExportDir,
    serverLogDays: config.logRetentionDays,
    requestResultDays: config.requestResultRetentionDays,
  });
  const accountPurge = new AccountPurgeJob(accounts);
  const arenaSeasonSweep = new ArenaSeasonJob(arenaSeasons);

  // Leaderboards (top lists cached in memory + Redis for `refreshSeconds`; `ranking.json`).
  const ranking = new RankingService({
    repo: new DrizzleRankingRepository(database),
    cache,
    clock,
    config: getRankingConfig,
    towers: getTowerCatalog,
    storyRegionIds: () => storyRegions(mapRules.catalog()).map((region) => region.id),
    guildWeek: () => getGuildConfig().quests,
  });

  // One live battle per player across rooms, devices and processes (battle rooms, `battle_active`, friends `inBattle`).
  const activeBattles = options.activeBattles ?? createColyseusActiveBattleRegistry();

  // ── Social: friends, private messages, friendly battles (`social.json`; pushes through the presence rooms) ──
  const socialRepo = new DrizzleSocialRepository(database);
  const dmRepo = new DrizzleDmRepository(database);
  // Late-bound: a block cancels the pending challenges, and the challenge service is built after the friends one.
  let friendly: FriendlyBattleService | null = null;
  const socialNotifier: SocialNotifier = { notify: async (userId, event) => { await runtime.pushSocialEvent(userId, event); } };
  const playerStatus = new PlayerStatusReader(socialRepo, activeBattles, clock, () => getSocialConfig().friends.onlineWindowSeconds);
  const friends = new FriendsService({
    friends: socialRepo,
    directory: socialRepo,
    status: playerStatus,
    notifier: socialNotifier,
    uow,
    clock,
    config: getSocialConfig,
    unread: dmRepo,
    onBlocked: (blockerId, blockedId) => friendly?.cancelBetween(blockerId, blockedId),
  });
  friendly = new FriendlyBattleService({
    matches: new DrizzleFriendlyMatchRepository(database),
    friendships: socialRepo,
    directory: socialRepo,
    status: playerStatus,
    notifier: socialNotifier,
    uow,
    clock,
    config: getSocialConfig,
    rooms: {
      // The match room is created on the server with a ticket only the server can sign (clients cannot create it).
      createMatchRoom: async (matchId) => {
        try {
          const room = await matchMaker.createRoom("battle_pvp", { matchId, ticket: signMatchTicket(config.jwtAccessSecret, matchId) });
          return String(room.roomId);
        } catch (error) {
          const busy = new RegExp(`${PVP_PLAYER_BUSY}:([\\w-]+)`).exec((error as Error)?.message ?? "");
          if (busy) throw new FriendlyRoomBusyError(busy[1]);
          throw error;
        }
      },
      roomExists: async (roomId) => Boolean(await matchMaker.driver.has(roomId)),
    },
  });
  const friendlyBattles = friendly;
  const pvpSessions = new PvpSessionFactory(battleSessionSources);
  const dms = new DmService({
    repo: dmRepo,
    friendships: socialRepo,
    directory: socialRepo,
    status: playerStatus,
    chat,
    notifier: socialNotifier,
    uow,
    clock,
    config: getSocialConfig,
  });

  // ── Rooms (dependency bindings) ─────────────────────────────────────
  const rooms = {
    auth: bindRoom(AuthRoom, { auth, limiter: limiters.auth, isMaintenanceEnabled: () => runtime.isMaintenanceEnabled() }),
    economy: bindRoom(EconomyRoom, { economy, limiter: limiters.mutation }),
    profile: bindRoom(ProfileRoom, { profiles, limiter: limiters.mutation }),
    account: bindRoom(AccountRoom, { accounts, queryLimiter: limiters.query, accountLimiter: limiters.account }),
    roster: bindRoom(RosterRoom, { roster, queryLimiter: limiters.query, mutationLimiter: limiters.mutation }),
    rune: bindRoom(RuneRoom, { runes, queryLimiter: limiters.query, mutationLimiter: limiters.mutation, devTools: config.devTools }),
    summon: bindRoom(SummonRoom, { summons, limiter: limiters.mutation }),
    presence: bindRoom(PresenceRoom, {
      presence,
      maintenanceState: () => runtime.getMaintenanceBroadcast(),
      reports,
      reportLimiter: limiters.account,
      activeBattles,
      queryLimiter: limiters.query,
    }),
    chatDirectory: bindRoom(ChatDirectoryRoom, { chat }),
    chat: bindRoom(ChatRoom, { chat, queryLimiter: limiters.query }),
    guildChat: bindRoom(GuildChatRoom, { guildChat, queryLimiter: limiters.query, sendLimiter: limiters.chatSend }),
    map: bindRoom(MapRoom, { maps, dungeons, towers, limiter: limiters.mutation, queryLimiter: limiters.query }),
    home: bindRoom(HomeRoom, { homes, limiter: limiters.mutation }),
    awaken: bindRoom(AwakeningRoom, { awakening, limiter: limiters.mutation }),
    battlePve: bindRoom(BattlePveRoom, {
      battles,
      arena: arenaBattles,
      limiter: limiters.battle,
      activeBattles,
      reconnectSeconds: () => getSocialConfig().battleRooms.reconnectSeconds,
    }),
    arena: bindRoom(ArenaRoom, { arena, queryLimiter: limiters.query, mutationLimiter: limiters.mutation }),
    shop: bindRoom(ShopRoom, { shop, queryLimiter: limiters.query, mutationLimiter: limiters.mutation }),
    guild: bindRoom(GuildRoom, { guilds, quests: guildQuests, queryLimiter: limiters.query, mutationLimiter: limiters.mutation }),
    mail: bindRoom(MailRoom, { mail, queryLimiter: limiters.query, mutationLimiter: limiters.mutation }),
    story: bindRoom(StoryRoom, { story, queryLimiter: limiters.query, mutationLimiter: limiters.mutation }),
    ranking: bindRoom(RankingRoom, { ranking, queryLimiter: limiters.query }),
    social: bindRoom(SocialRoom, { friends, dms, friendly: friendlyBattles, queryLimiter: limiters.query, mutationLimiter: limiters.mutation, sendLimiter: limiters.chatSend }),
    battlePvp: bindRoom(BattlePvpRoom, {
      matches: friendlyBattles,
      sessions: pvpSessions,
      defenses: { defenseOf: (userId) => arenaRepo.findDefense(userId) },
      directory: socialRepo,
      activeBattles,
      notifier: socialNotifier,
      rules: () => getSocialConfig().friendlyBattle,
      limiter: limiters.battle,
      ticketSecret: config.jwtAccessSecret,
    }),
    missions: bindRoom(MissionsRoom, { missions, attendance, newbieQuests, queryLimiter: limiters.query, mutationLimiter: limiters.mutation }),
  };

  return {
    config,
    clock,
    uow,
    audit,
    authenticator,
    sessions,
    limiters,
    services: { auth, accounts, economy, ledger, profiles, roster, runes, summons, awakening, maps, homes, chat, guildChat, presence, grants, adminPlayers, adminEdits, adminAnalytics, adminGuilds, adminModeration, adminReports, adminConfig, adminLogs, reports, textFilter, catalogs, progression, battles, battleRewards, dungeons, shop, arena, arenaBattles, arenaSeasons, guilds, guildQuests, mail, story, missions, attendance, newbieQuests, towers, ranking, activity, friends, dms, friendlyBattles, playerStatus },
    jobs: { retention, accountPurge, arenaSeasonSweep },
    activeBattles,
    logStore,
    runtime,
    rooms,
  };
}

export type AppContainer = ReturnType<typeof createContainer>;
