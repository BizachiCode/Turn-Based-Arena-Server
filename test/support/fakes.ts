// In-memory fakes of the persistence ports, used by service unit tests.

import type { CurrencyCfg } from "../../src/config/CurrencyCatalog";
import type { DbSession, UnitOfWork } from "../../src/shared/kernel/unit-of-work";
import type { CurrencyRules, WalletRepository, WalletRow } from "../../src/modules/economy/economy.ports";
import type { Capacity, CharacterRecord, CharacterRepository, Location, LocationCounts, NewCharacter } from "../../src/modules/roster/roster.ports";
import type { MapProgressRepository, StageClearOutcome, StageProgressRecord } from "../../src/modules/map/map.ports";
import type { StageDifficulty } from "../../src/shared/kernel/types";
import { getNearestFootprintRotation, type HomeCatalog } from "../../src/config/HomeCatalog";
import type { HomeInventoryEntryDto, HomeObjectRow, HomeProductionRow } from "../../src/modules/home/home.dto";
import type { BuildingInventoryRepository, HomeProductionRepository, HomeRepository, HomeRules } from "../../src/modules/home/home.ports";

export const SESSION: DbSession = { kind: "db-session" };

/** Runs work immediately; rolls back registered snapshots when the work throws. */
export class InMemoryUnitOfWork implements UnitOfWork {
  private readonly participants: Array<{ snapshot(): unknown; restore(state: unknown): void }> = [];
  transactions = 0;

  register(participant: { snapshot(): unknown; restore(state: unknown): void }): this {
    this.participants.push(participant);
    return this;
  }

  async transaction<T>(work: (session: DbSession) => Promise<T>): Promise<T> {
    this.transactions++;
    const snapshots = this.participants.map((participant) => participant.snapshot());
    try {
      return await work(SESSION);
    } catch (error) {
      this.participants.forEach((participant, index) => participant.restore(snapshots[index]));
      throw error;
    }
  }
}

export class InMemoryWalletRepository implements WalletRepository {
  rows = new Map<string, Map<string, WalletRow>>();
  levels = new Map<string, number>();

  private userRows(userId: string): Map<string, WalletRow> {
    let rows = this.rows.get(userId);
    if (!rows) this.rows.set(userId, (rows = new Map()));
    return rows;
  }

  set(userId: string, currencyId: string, amount: number, lastTickAt: Date | null = null): void {
    this.userRows(userId).set(currencyId, { currencyId, amount, lastTickAt });
  }

  amount(userId: string, currencyId: string): number {
    return this.userRows(userId).get(currencyId)?.amount ?? 0;
  }

  async listWallet(userId: string): Promise<WalletRow[]> {
    return [...this.userRows(userId).values()].map((row) => ({ ...row }));
  }

  async insertMissing(userId: string, rows: WalletRow[]): Promise<void> {
    for (const row of rows) if (!this.userRows(userId).has(row.currencyId)) this.userRows(userId).set(row.currencyId, { ...row });
  }

  async lockRows(userId: string, currencyIds: string[]): Promise<Map<string, WalletRow>> {
    const result = new Map<string, WalletRow>();
    for (const id of currencyIds) {
      if (!this.userRows(userId).has(id)) this.userRows(userId).set(id, { currencyId: id, amount: 0, lastTickAt: null });
      result.set(id, { ...this.userRows(userId).get(id)! });
    }
    return result;
  }

  async saveRow(userId: string, row: WalletRow): Promise<void> {
    this.userRows(userId).set(row.currencyId, { ...row });
  }

  async getAccountLevel(userId: string): Promise<number> {
    return this.levels.get(userId) ?? 1;
  }

  snapshot(): unknown {
    return new Map([...this.rows].map(([user, rows]) => [user, new Map([...rows].map(([id, row]) => [id, { ...row }]))]));
  }

  restore(state: unknown): void {
    this.rows = state as Map<string, Map<string, WalletRow>>;
  }
}

export function currencyRulesOf(currencies: Array<Partial<CurrencyCfg> & { id: string }>): CurrencyRules {
  const full: CurrencyCfg[] = currencies.map((currency) => ({
    initialAmount: 0,
    rechargeable: false,
    rechargeAmount: 0,
    rechargeIntervalSeconds: 0,
    rechargeOffline: false,
    hasCap: false,
    baseCap: 0,
    capScalesWithLevel: false,
    capIncrementsByLevel: [],
    canOverflowAboveCap: false,
    ...currency,
  }));
  return { get: (id) => full.find((currency) => currency.id === id), list: () => full };
}

export class InMemoryCharacterRepository implements CharacterRepository {
  records = new Map<string, CharacterRecord & { userId: string }>();
  capacity: Capacity = { bagCapacity: 10, storageCapacity: 10 };
  equippedRuneOwners = new Set<string>();

  add(userId: string, record: Partial<CharacterRecord> & { uid: string; characterId: string }): void {
    this.records.set(record.uid, {
      userId,
      stars: 1,
      level: 1,
      currentExp: 0,
      awakeningIndex: 0,
      skillLevels: [1],
      locked: false,
      location: "BAG",
      createdAt: new Date(0),
      ...record,
    });
  }

  private owned(userId: string): Array<CharacterRecord & { userId: string }> {
    return [...this.records.values()].filter((record) => record.userId === userId);
  }

  async countByLocation(userId: string, location: Location): Promise<number> {
    return this.owned(userId).filter((record) => record.location === location).length;
  }

  async listByLocation(userId: string, location: Location, offset: number, limit: number): Promise<CharacterRecord[]> {
    return this.owned(userId).filter((record) => record.location === location).slice(offset, offset + limit);
  }

  async listByUids(userId: string, uids: string[]): Promise<CharacterRecord[]> {
    return this.owned(userId).filter((record) => uids.includes(record.uid)).map((record) => ({ ...record }));
  }

  async lockByUids(userId: string, uids: string[]): Promise<CharacterRecord[]> {
    return this.listByUids(userId, uids);
  }

  async ownsCharacterId(userId: string, characterId: string): Promise<boolean> {
    return this.owned(userId).some((record) => record.characterId === characterId);
  }

  async getCapacity(): Promise<Capacity> {
    return { ...this.capacity };
  }

  async getCounts(userId: string): Promise<LocationCounts> {
    return {
      bagCount: await this.countByLocation(userId, "BAG"),
      storageCount: await this.countByLocation(userId, "STORAGE"),
    };
  }

  async moveCharacters(userId: string, from: Location, to: Location, uids: string[]): Promise<number> {
    let moved = 0;
    for (const record of this.owned(userId)) {
      if (uids.includes(record.uid) && record.location === from) {
        record.location = to;
        moved++;
      }
    }
    return moved;
  }

  async updateProgress(userId: string, uid: string, level: number, currentExp: number): Promise<number> {
    const record = this.records.get(uid);
    if (!record || record.userId !== userId) return 0;
    Object.assign(record, { level, currentExp });
    return 1;
  }

  async updateSkillLevels(userId: string, uid: string, skillLevels: number[]): Promise<number> {
    const record = this.records.get(uid);
    if (!record || record.userId !== userId) return 0;
    record.skillLevels = [...skillLevels];
    return 1;
  }

  async updateStars(userId: string, uid: string, stars: number): Promise<number> {
    const record = this.records.get(uid);
    if (!record || record.userId !== userId) return 0;
    Object.assign(record, { stars, level: 1, currentExp: 0 });
    return 1;
  }

  async updateAwakening(userId: string, uid: string, awakeningIndex: number): Promise<number> {
    const record = this.records.get(uid);
    if (!record || record.userId !== userId) return 0;
    record.awakeningIndex = awakeningIndex;
    return 1;
  }

  async updateLocked(userId: string, uid: string, locked: boolean): Promise<number> {
    const record = this.records.get(uid);
    if (!record || record.userId !== userId) return 0;
    record.locked = locked;
    return 1;
  }

  async deleteCharacters(userId: string, uids: string[]): Promise<number> {
    let deleted = 0;
    for (const uid of uids) {
      const record = this.records.get(uid);
      if (record && record.userId === userId) { this.records.delete(uid); deleted++; }
    }
    return deleted;
  }

  async setCapacity(_userId: string, capacity: Capacity): Promise<void> {
    this.capacity = { ...capacity };
  }

  async deleteFromBag(userId: string, uids: string[]): Promise<number> {
    let deleted = 0;
    for (const uid of uids) {
      const record = this.records.get(uid);
      if (record && record.userId === userId && record.location === "BAG") {
        this.records.delete(uid);
        deleted++;
      }
    }
    return deleted;
  }

  async insertCharacter(userId: string, character: NewCharacter): Promise<void> {
    this.add(userId, { ...character, locked: false, createdAt: new Date() });
  }

  async countEquippedRunes(_userId: string, characterUids: string[]): Promise<number> {
    return characterUids.filter((uid) => this.equippedRuneOwners.has(uid)).length;
  }

  snapshot(): unknown {
    return new Map([...this.records].map(([uid, record]) => [uid, { ...record }]));
  }

  restore(state: unknown): void {
    this.records = state as Map<string, CharacterRecord & { userId: string }>;
  }
}

export class InMemoryMapProgressRepository implements MapProgressRepository {
  rows: Array<StageProgressRecord & { userId: string }> = [];

  async listProgress(userId: string): Promise<StageProgressRecord[]> {
    return this.rows.filter((row) => row.userId === userId && row.clears > 0).map(({ userId: _ignored, ...row }) => row);
  }

  async touchPrefs(): Promise<void> {}

  async recordClear(userId: string, regionId: string, stageId: string, difficulty: StageDifficulty, clearMs: number | null): Promise<StageClearOutcome> {
    let row = this.rows.find((entry) => entry.userId === userId && entry.regionId === regionId && entry.stageId === stageId && entry.difficulty === difficulty);
    const firstClear = !row;
    if (!row) {
      row = { userId, regionId, stageId, difficulty, clears: 0, bestClearMs: null };
      this.rows.push(row);
    }
    row.clears++;
    if (clearMs != null) row.bestClearMs = row.bestClearMs == null ? clearMs : Math.min(row.bestClearMs, clearMs);
    return { firstClear, clears: row.clears, bestClearMs: row.bestClearMs };
  }

  snapshot(): unknown {
    return this.rows.map((row) => ({ ...row }));
  }

  restore(state: unknown): void {
    this.rows = state as Array<StageProgressRecord & { userId: string }>;
  }
}

import type { NewStageTicket, PveBattleRecord, PveBattleRepository } from "../../src/modules/battle-pve/battle-pve.ports";

export class InMemoryPveBattleRepository implements PveBattleRepository {
  rows: Array<PveBattleRecord & { createdAt: Date }> = [];

  async createTicket(ticket: NewStageTicket, _session?: DbSession): Promise<void> {
    this.rows.push({ ...ticket, status: "TICKET", battleId: null, startedAt: null, result: null, createdAt: new Date() });
  }

  async hasUsableTicket(userId: string, stage: { regionId: string; stageId: string; difficulty: string }, notBefore: Date, ticketId: string | null): Promise<boolean> {
    return this.rows.some((entry) => entry.userId === userId && entry.status === "TICKET" && entry.regionId === stage.regionId
      && entry.stageId === stage.stageId && entry.difficulty === stage.difficulty && entry.createdAt >= notBefore
      && (!ticketId || entry.id === ticketId));
  }

  async consumeTicket(userId: string, stage: { regionId: string; stageId: string; difficulty: string }, battleId: string, notBefore: Date, ticketId: string | null, _session?: DbSession): Promise<PveBattleRecord | null> {
    const row = this.rows
      .filter((entry) => entry.userId === userId && entry.status === "TICKET" && entry.regionId === stage.regionId
        && entry.stageId === stage.stageId && entry.difficulty === stage.difficulty && entry.createdAt >= notBefore
        && (!ticketId || entry.id === ticketId))
      .pop();
    if (!row) return null;
    Object.assign(row, { status: "STARTED", battleId, startedAt: new Date() });
    return { ...row };
  }

  async lockByBattleId(userId: string, battleId: string): Promise<PveBattleRecord | null> {
    const row = this.rows.find((entry) => entry.userId === userId && entry.battleId === battleId);
    return row ? { ...row } : null;
  }

  async finish(id: string, status: "VICTORY" | "DEFEAT", result: unknown): Promise<void> {
    const row = this.rows.find((entry) => entry.id === id);
    if (row) Object.assign(row, { status, result: JSON.parse(JSON.stringify(result)) });
  }

  snapshot(): unknown {
    return this.rows.map((row) => ({ ...row }));
  }

  restore(state: unknown): void {
    this.rows = state as Array<PveBattleRecord & { createdAt: Date }>;
  }
}

export function homeRulesOf(catalog: HomeCatalog): HomeRules {
  return {
    catalog: () => catalog,
    getBuildable: (id) => catalog.buildables.find((entry) => entry.id === id),
    getIsland: (id) => catalog.islands.find((entry) => entry.id === id),
    footprintFor: (buildable, yawDegrees) => getNearestFootprintRotation(buildable, yawDegrees),
  };
}

export class InMemoryHomeRepository implements HomeRepository {
  rows: Array<HomeObjectRow & { userId: string }> = [];
  prefs = new Map<string, { selectedIslandId: string | null; revision: number }>();
  unlocked = new Set<string>();

  async listUnlockedIslands(userId: string): Promise<string[]> {
    return [...this.unlocked].filter((key) => key.startsWith(`${userId}|`)).map((key) => key.split("|")[1]);
  }
  async unlockIsland(userId: string, islandId: string): Promise<boolean> {
    const key = `${userId}|${islandId}`;
    if (this.unlocked.has(key)) return false;
    this.unlocked.add(key);
    return true;
  }

  async listObjects(userId: string): Promise<HomeObjectRow[]> {
    return this.rows.filter((row) => row.userId === userId).map(({ userId: _owner, ...row }) => ({ ...row }));
  }
  async getPrefs(userId: string) {
    return { ...(this.prefs.get(userId) ?? { selectedIslandId: null, revision: 0 }) };
  }
  async commitMutation(userId: string, islandId: string): Promise<void> {
    this.prefs.set(userId, { selectedIslandId: islandId, revision: (this.prefs.get(userId)?.revision ?? 0) + 1 });
  }
  async upsertPlayerObject(userId: string, row: Omit<HomeObjectRow, "templateInstanceId" | "state" | "isTemplateObject">): Promise<void> {
    this.rows = this.rows.filter((entry) => !(entry.userId === userId && entry.instanceId === row.instanceId));
    this.rows.push({ userId, templateInstanceId: null, state: "ACTIVE", isTemplateObject: false, ...row });
  }
  async upsertTemplateState(userId: string, row: HomeObjectRow): Promise<void> {
    this.rows = this.rows.filter((entry) => !(entry.userId === userId && entry.instanceId === row.instanceId));
    this.rows.push({ userId, ...row });
  }
  async deletePlayerObject(userId: string, instanceId: string): Promise<void> {
    this.rows = this.rows.filter((entry) => !(entry.userId === userId && entry.instanceId === instanceId && !entry.isTemplateObject));
  }
  snapshot(): unknown { return { rows: this.rows.map((row) => ({ ...row })), prefs: new Map(this.prefs), unlocked: new Set(this.unlocked) }; }
  restore(state: unknown): void {
    const saved = state as { rows: InMemoryHomeRepository["rows"]; prefs: InMemoryHomeRepository["prefs"]; unlocked: Set<string> };
    this.rows = saved.rows;
    this.prefs = saved.prefs;
    this.unlocked = saved.unlocked;
  }
}

export class InMemoryHomeProductionRepository implements HomeProductionRepository {
  rows: Array<HomeProductionRow & { userId: string }> = [];

  /** Test helper: the stored row of a building (undefined = never touched). */
  find(userId: string, instanceId: string): HomeProductionRow | undefined {
    const row = this.rows.find((entry) => entry.userId === userId && entry.instanceId === instanceId);
    if (!row) return undefined;
    const { userId: _owner, ...rest } = row;
    return { ...rest, units: [...rest.units] };
  }
  async list(userId: string): Promise<HomeProductionRow[]> {
    return this.rows.filter((row) => row.userId === userId).map(({ userId: _owner, ...row }) => ({ ...row, units: [...row.units] }));
  }
  async upsert(userId: string, row: HomeProductionRow): Promise<void> {
    this.rows = this.rows.filter((entry) => !(entry.userId === userId && entry.instanceId === row.instanceId));
    this.rows.push({ userId, ...row, units: [...row.units] });
  }
  async delete(userId: string, instanceId: string): Promise<void> {
    this.rows = this.rows.filter((entry) => !(entry.userId === userId && entry.instanceId === instanceId));
  }
  snapshot(): unknown { return this.rows.map((row) => ({ ...row, units: [...row.units] })); }
  restore(state: unknown): void { this.rows = state as typeof this.rows; }
}

export class InMemoryBuildingInventory implements BuildingInventoryRepository {
  stock = new Map<string, number>();

  amount(userId: string, buildableId: string): number {
    return this.stock.get(`${userId}|${buildableId}`) ?? 0;
  }
  async list(userId: string): Promise<HomeInventoryEntryDto[]> {
    return [...this.stock].filter(([key, count]) => key.startsWith(`${userId}|`) && count > 0)
      .map(([key, count]) => ({ buildableId: key.split("|")[1], count }))
      .sort((a, b) => a.buildableId.localeCompare(b.buildableId));
  }
  async add(userId: string, buildableId: string, count: number): Promise<void> {
    this.stock.set(`${userId}|${buildableId}`, this.amount(userId, buildableId) + count);
  }
  async consume(userId: string, buildableId: string, count: number): Promise<boolean> {
    if (this.amount(userId, buildableId) < count) return false;
    this.stock.set(`${userId}|${buildableId}`, this.amount(userId, buildableId) - count);
    return true;
  }
  snapshot(): unknown { return new Map(this.stock); }
  restore(state: unknown): void { this.stock = state as Map<string, number>; }
}

// ── Accounts (auth + account services) ─────────────────────────────────

import type { AccountRow, AuditKind, AuthRepository, RefreshLookupRow, RefreshTokenRecord, UserCredentialsRow } from "../../src/modules/auth/auth.ports";
import type { ProfileRepository, ProfileRow } from "../../src/modules/profile/profile.ports";
import type { PasswordHasher } from "../../src/shared/security/password-hasher";
import type { SessionData, SessionStore } from "../../src/shared/security/session-store";

/** mysql2-style duplicate key error wrapped like Drizzle's DrizzleQueryError (code on `cause`). */
export function duplicateKeyError(): Error {
  const cause = Object.assign(new Error("Duplicate entry"), { code: "ER_DUP_ENTRY", errno: 1062 });
  return Object.assign(new Error("Failed query: insert into users"), { cause });
}

/** Fast, deterministic stand-in for Argon2 (tests only). */
export class PlainPasswordHasher implements PasswordHasher {
  async hash(plain: string): Promise<string> { return "plain:" + plain; }
  async verify(plain: string, passwordHash: string): Promise<boolean> { return passwordHash === "plain:" + plain; }
}

export class InMemorySessionStore implements SessionStore {
  sessions = new Map<string, SessionData>();
  private key(userId: string, deviceId: string) { return userId + "|" + deviceId; }
  devices(userId: string): string[] {
    return [...this.sessions.keys()].filter((key) => key.startsWith(userId + "|")).map((key) => key.slice(userId.length + 1)).sort();
  }
  async setSession(userId: string, deviceId: string, data: SessionData) { this.sessions.set(this.key(userId, deviceId), { ...data }); }
  async getSession(userId: string, deviceId: string) { return this.sessions.get(this.key(userId, deviceId)) ?? null; }
  async deleteSession(userId: string, deviceId: string) { this.sessions.delete(this.key(userId, deviceId)); }
  async deleteAllSessions(userId: string) { for (const deviceId of this.devices(userId)) this.sessions.delete(this.key(userId, deviceId)); }
  async deleteSessionsExcept(userId: string, keepDeviceId: string) {
    const removed = this.devices(userId).filter((deviceId) => deviceId !== keepDeviceId);
    for (const deviceId of removed) this.sessions.delete(this.key(userId, deviceId));
    return removed;
  }
  async touchSession() {}
}

export class InMemoryProfileRepository implements ProfileRepository {
  rows = new Map<string, ProfileRow>();
  async findByUserId(userId: string) { const row = this.rows.get(userId); return row ? { ...row } : null; }
  async isNameTaken(name: string, exceptUserId?: string) { return [...this.rows].some(([userId, row]) => row.name === name && userId !== exceptUserId); }
  async insertProfile(userId: string, profile: ProfileRow) { this.rows.set(userId, { ...profile }); }
  async updateNickname(userId: string, nickname: string) { const row = this.rows.get(userId); if (row) row.name = nickname; }
  async updateIcon(userId: string, iconId: string) { const row = this.rows.get(userId); if (row) row.iconId = iconId; }
  async lockProgress(userId: string) { const row = this.rows.get(userId); return row ? { level: row.level, currentExp: row.currentExp } : null; }
  async updateProgress(userId: string, level: number, currentExp: number) { const row = this.rows.get(userId); if (row) { row.level = level; row.currentExp = currentExp; } }
  snapshot(): unknown { return new Map([...this.rows].map(([id, row]) => [id, { ...row }])); }
  restore(state: unknown): void { this.rows = state as Map<string, ProfileRow>; }
}

type TokenRow = { userId: string; deviceId: string; tokenHash: string; expiresAt: Date; isRevoked: boolean };
type AuthFakeState = {
  users: Map<string, AccountRow>;
  tokens: TokenRow[];
  tokenLog: Array<{ userId: string; deviceId: string; tokenHash: string; action: string }>;
  audits: Array<{ userId: string | null; kind: AuditKind; meta: Record<string, unknown> | null }>;
};

/** In-memory {@link AuthRepository}: users with unique email/username, one refresh token per (user, device). */
export class InMemoryAuthRepository implements AuthRepository {
  users = new Map<string, AccountRow>();
  tokens: TokenRow[] = [];
  tokenLog: AuthFakeState["tokenLog"] = [];
  audits: AuthFakeState["audits"] = [];
  /** Next N user inserts fail with a duplicate-key error (guest name collisions). */
  failNextInserts = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  private credentials(row: AccountRow): UserCredentialsRow {
    const { email: _e, createdAt: _c, deletionRequestedAt: _r, passwordChangedAt: _p, ...credentials } = row;
    return { ...credentials };
  }

  async findByEmailOrUsername(emailOrUsername: string) {
    const row = [...this.users.values()].find((entry) => entry.email === emailOrUsername || entry.username === emailOrUsername);
    return row ? this.credentials(row) : null;
  }
  async existsByEmailOrUsername(email: string, username: string) {
    return [...this.users.values()].some((row) => row.email === email || row.username === username);
  }
  async insertUser(userId: string, email: string, username: string, passwordHash: string, isGuest: boolean) {
    if (this.failNextInserts > 0) { this.failNextInserts--; throw duplicateKeyError(); }
    if (await this.existsByEmailOrUsername(email, username)) throw duplicateKeyError();
    this.users.set(userId, {
      id: userId, email, username, passwordHash, isGuest, failedLogins: 0, lockedUntil: null, isBanned: false, banReason: null,
      banExpiresAt: null, createdAt: new Date(Math.floor(this.now().getTime() / 1000) * 1000), deletionRequestedAt: null,
      deletionScheduledAt: null, passwordChangedAt: null,
    });
  }
  async getAccountById(userId: string) { const row = this.users.get(userId); return row ? { ...row } : null; }
  async updateCredentials(userId: string, email: string, passwordHash: string, isGuest: boolean, changedAt: Date) {
    if ([...this.users.values()].some((row) => row.id !== userId && row.email === email)) throw duplicateKeyError();
    Object.assign(this.users.get(userId)!, { email, passwordHash, isGuest, passwordChangedAt: changedAt });
  }
  async updatePasswordHash(userId: string, passwordHash: string, changedAt: Date) {
    Object.assign(this.users.get(userId)!, { passwordHash, passwordChangedAt: changedAt });
  }
  async setDeletionSchedule(userId: string, requestedAt: Date | null, scheduledAt: Date | null) {
    Object.assign(this.users.get(userId)!, { deletionRequestedAt: requestedAt, deletionScheduledAt: scheduledAt });
  }
  async findUsersDueForDeletion(now: Date, limit: number) {
    return [...this.users.values()]
      .filter((row) => row.deletionScheduledAt && row.deletionScheduledAt.getTime() <= now.getTime())
      .sort((a, b) => a.deletionScheduledAt!.getTime() - b.deletionScheduledAt!.getTime())
      .slice(0, limit)
      .map((row) => row.id);
  }
  async deleteUsers(userIds: string[]) {
    let deleted = 0;
    for (const userId of userIds) if (this.users.delete(userId)) deleted++;
    // FK cascade (tokens), explicit cleanup (token log), ON DELETE SET NULL (audit).
    this.tokens = this.tokens.filter((row) => !userIds.includes(row.userId));
    this.tokenLog = this.tokenLog.filter((row) => !userIds.includes(row.userId));
    for (const entry of this.audits) if (entry.userId && userIds.includes(entry.userId)) entry.userId = null;
    return deleted;
  }
  async getUsername(userId: string) { return this.users.get(userId)?.username ?? null; }
  async setFailedLogins(userId: string, failedLogins: number, lockedUntil: Date | null) {
    Object.assign(this.users.get(userId)!, { failedLogins, lockedUntil });
  }
  async markLoginSuccess(userId: string) { Object.assign(this.users.get(userId)!, { failedLogins: 0, lockedUntil: null }); }
  async setBan(userId: string, banned: boolean, reason: string | null, until: Date | null) {
    Object.assign(this.users.get(userId)!, { isBanned: banned, banReason: banned ? reason : null, banExpiresAt: banned ? until : null });
  }
  async saveRefreshToken(record: RefreshTokenRecord, action: "ISSUE" | "REFRESH") {
    this.tokens = this.tokens.filter((row) => !(row.userId === record.userId && row.deviceId === record.deviceId));
    this.tokens.push({ userId: record.userId, deviceId: record.deviceId, tokenHash: record.tokenHash, expiresAt: record.expiresAt, isRevoked: false });
    this.tokenLog.push({ userId: record.userId, deviceId: record.deviceId, tokenHash: record.tokenHash, action });
  }
  async findRefreshToken(userId: string, deviceId: string, tokenHash: string): Promise<RefreshLookupRow | null> {
    const token = this.tokens.find((row) => row.userId === userId && row.deviceId === deviceId && row.tokenHash === tokenHash && row.expiresAt > this.now());
    const user = this.users.get(userId);
    if (!token || !user) return null;
    return {
      username: user.username, isBanned: user.isBanned, banReason: user.banReason, banExpiresAt: user.banExpiresAt,
      deletionScheduledAt: user.deletionScheduledAt, isRevoked: token.isRevoked,
    };
  }
  async revokeRefreshToken(userId: string, deviceId: string, tokenHash: string) {
    const matches = this.tokens.filter((row) => row.userId === userId && row.deviceId === deviceId && row.tokenHash === tokenHash);
    if (matches.length === 0) return false;
    for (const row of matches) row.isRevoked = true;
    this.tokenLog.push({ userId, deviceId, tokenHash, action: "REVOKE" });
    return true;
  }
  private revokeActive(userId: string, keepDeviceId: string | null): string[] {
    const active = this.tokens.filter((row) => row.userId === userId && !row.isRevoked && row.deviceId !== keepDeviceId);
    for (const row of active) {
      row.isRevoked = true;
      this.tokenLog.push({ userId, deviceId: row.deviceId, tokenHash: row.tokenHash, action: "REVOKE" });
    }
    return active.map((row) => row.deviceId);
  }
  async revokeRefreshTokensExcept(userId: string, keepDeviceId: string) { return this.revokeActive(userId, keepDeviceId); }
  async revokeAllRefreshTokens(userId: string) { return this.revokeActive(userId, null); }
  async deleteExpiredRefreshTokens() { return 0; }
  async audit(userId: string | null, kind: AuditKind, meta: Record<string, unknown> | null) { this.audits.push({ userId, kind, meta }); }

  snapshot(): unknown {
    const state: AuthFakeState = {
      users: new Map([...this.users].map(([id, row]) => [id, { ...row }])),
      tokens: this.tokens.map((row) => ({ ...row })),
      tokenLog: this.tokenLog.map((row) => ({ ...row })),
      audits: this.audits.map((row) => ({ ...row })),
    };
    return state;
  }
  restore(state: unknown): void {
    const saved = state as AuthFakeState;
    this.users = saved.users;
    this.tokens = saved.tokens;
    this.tokenLog = saved.tokenLog;
    this.audits = saved.audits;
  }
}

/** Delivered store transactions (`user_iap_transactions`). */
export class InMemoryIapTransactionRepository {
  rows = new Map<string, { userId: string; purchaseId: string; store: string; itemId: string; environment: string }>();
  async findOwner(transactionKey: string): Promise<{ userId: string; purchaseId: string } | null> {
    const row = this.rows.get(transactionKey);
    return row ? { userId: row.userId, purchaseId: row.purchaseId } : null;
  }
  async insert(record: { transactionKey: string; userId: string; purchaseId: string; store: string; itemId: string; environment: string }): Promise<boolean> {
    if (this.rows.has(record.transactionKey)) return false;
    this.rows.set(record.transactionKey, { userId: record.userId, purchaseId: record.purchaseId, store: record.store, itemId: record.itemId, environment: record.environment });
    return true;
  }
  snapshot(): unknown { return new Map(this.rows); }
  restore(state: unknown): void { this.rows = state as InMemoryIapTransactionRepository["rows"]; }
}
