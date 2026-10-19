// GM panel "Players": one account's full picture and the operator actions on it — moderation (kick, ban, chat mute),
// wallet balances, account level and story/tutorial resets. Every action is audited on the player's trail.

import type { AuditLog } from "../../shared/kernel/audit.js";
import type { Clock } from "../../shared/kernel/clock.js";
import type { UnitOfWork, DbSession } from "../../shared/kernel/unit-of-work.js";
import type { SessionStore } from "../../shared/security/session-store.js";
import { notifyUserRevoked } from "../../shared/rooms/user-revocation.js";
import type { CurrencyRules } from "../economy/economy.ports.js";
import type { EconomyService } from "../economy/economy.service.js";
import type { WalletLedger } from "../economy/wallet-ledger.js";
import type { AccountProgressRepository } from "../progression/account-progression.service.js";
import type { AdminUserDirectory, AdminUserRef } from "./admin.ports.js";
import type { AdminAuditEntry, AdminPlayerDetail, AdminPlayerList, AdminPlayerListQuery, AdminPlayerRepository } from "./admin-players.ports.js";
import type { GrantNotifier } from "./runtime-grants.service.js";

/** Account writes the GM tools need (implemented by the auth repository). */
export interface AdminAccountWriter {
  setBan(userId: string, banned: boolean, reason: string | null, until: Date | null, session?: DbSession): Promise<void>;
  revokeAllRefreshTokens(userId: string, session: DbSession): Promise<string[]>;
}

/** Closes a player's live connections (runtime state / presence). */
export interface PlayerDisconnector {
  disconnectPlayer(userId: string, reason: string, closeCode?: number, targetLabel?: string): Promise<number>;
}

export type AdminPlayersDeps = {
  users: AdminUserDirectory;
  players: AdminPlayerRepository;
  accounts: AdminAccountWriter;
  sessions: SessionStore;
  disconnector: PlayerDisconnector;
  economy: EconomyService;
  ledger: WalletLedger;
  currencies: CurrencyRules;
  profiles: AccountProgressRepository;
  notifier: GrantNotifier;
  audit: AuditLog;
  uow: UnitOfWork;
  clock: Clock;
  /** Highest account level (config.json > gameplay.accountExp). */
  maxAccountLevel: () => number;
  /** Dialogue ids known to the story catalog (resets of unknown ids are refused). */
  knownDialogue: (dialogueId: string) => boolean;
  /** Called after a chat mute/unmute so caches of the mute state drop the player. */
  onMuteChanged?: (userId: string) => void;
};

/** A ban/mute without an end date lasts this long (stored as a date so the checks stay simple). */
const ONLINE_WINDOW_MS = 60_000;
const PERMANENT_MS = 100 * 365 * 24 * 3600 * 1000;

export class AdminPlayersService {
  constructor(private readonly deps: AdminPlayersDeps) {}

  async getDetail(selector: string): Promise<AdminPlayerDetail> {
    const target = await this.resolve(selector);
    const detail = await this.deps.players.loadDetail(target.userId);
    if (!detail) throw new AdminPlayerError("Player not found.");
    await this.deps.economy.ensureUserCurrencies(target.userId);
    const onlineSince = this.deps.clock.now().getTime() - ONLINE_WINDOW_MS;
    const online = detail.connections.some((c) => Date.parse(c.lastHeartbeatAt) > onlineSince);
    return { ...detail, online, wallet: await this.deps.ledger.snapshot(target.userId) };
  }

  /** Players list (tabs, search, sort, paging). A heartbeat newer than a minute counts as online. */
  async list(input: Partial<Omit<AdminPlayerListQuery, "onlineSince" | "now">>): Promise<AdminPlayerList & { page: number; pageSize: number }> {
    const now = this.deps.clock.now();
    const query: AdminPlayerListQuery = {
      filter: input.filter ?? "all",
      q: input.q?.trim() || null,
      sort: input.sort ?? "lastLogin",
      dir: input.dir ?? "desc",
      page: Math.max(1, Math.floor(input.page ?? 1)),
      pageSize: Math.max(1, Math.min(100, Math.floor(input.pageSize ?? 25))),
      onlineSince: new Date(now.getTime() - ONLINE_WINDOW_MS),
      now,
    };
    return { ...(await this.deps.players.listPlayers(query)), page: query.page, pageSize: query.pageSize };
  }

  /** Revokes every access session and refresh token (all devices) and closes the connections; the player may log in again. */
  async revokeSessions(selector: string, reason?: string): Promise<{ userId: string; connections: number }> {
    const target = await this.resolve(selector);
    const text = normalize(reason) ?? "Signed out by a GM.";
    await this.deps.uow.transaction(async (session) => {
      await this.deps.accounts.revokeAllRefreshTokens(target.userId, session);
      await this.deps.audit.record({ userId: target.userId, kind: "GM_REVOKE_SESSIONS", meta: { reason: text } }, session);
    });
    await this.deps.sessions.deleteAllSessions(target.userId);
    // Every room drops the connections of the deleted sessions, even without a presence connection to kick.
    notifyUserRevoked(target.userId);
    const connections = await this.deps.disconnector.disconnectPlayer(target.userId, text, undefined, target.username);
    return { userId: target.userId, connections };
  }

  async auditTrail(selector: string, limit: number, beforeId?: number): Promise<AdminAuditEntry[]> {
    const target = await this.resolve(selector);
    return this.deps.players.auditTrail(target.userId, Math.max(1, Math.min(200, limit)), beforeId);
  }

  /** Revokes the access sessions (not the refresh tokens: the player may log in again) and closes the connections. */
  async kick(selector: string, reason?: string): Promise<{ userId: string; connections: number }> {
    const target = await this.resolve(selector);
    const text = normalize(reason) ?? "Disconnected by a GM.";
    await this.deps.sessions.deleteAllSessions(target.userId);
    // Every room drops the connections of the deleted sessions, even without a presence connection to kick.
    notifyUserRevoked(target.userId);
    const connections = await this.deps.disconnector.disconnectPlayer(target.userId, text, undefined, target.username);
    await this.deps.audit.record({ userId: target.userId, kind: "GM_KICK", meta: { reason: text, connections } });
    return { userId: target.userId, connections };
  }

  /** Bans until `until` (null = permanent): every token is revoked and the player is disconnected. */
  async ban(selector: string, until: Date | null, reason?: string): Promise<{ userId: string; until: string | null; connections: number }> {
    const target = await this.resolve(selector);
    if (until && until.getTime() <= this.deps.clock.nowMs()) throw new AdminPlayerError("The ban must end in the future.");
    const text = normalize(reason);
    await this.deps.uow.transaction(async (session) => {
      await this.deps.accounts.setBan(target.userId, true, text, until, session);
      await this.deps.accounts.revokeAllRefreshTokens(target.userId, session);
      await this.deps.audit.record({ userId: target.userId, kind: "BAN", meta: { by: "gm", reason: text, until: until?.toISOString() ?? null } }, session);
    });
    await this.deps.sessions.deleteAllSessions(target.userId);
    // Every room drops the connections of the deleted sessions, even without a presence connection to kick.
    notifyUserRevoked(target.userId);
    const notice = until ? `Account banned until ${until.toISOString()}.` : "Account banned.";
    const connections = await this.deps.disconnector.disconnectPlayer(target.userId, text ? `${notice} ${text}` : notice, undefined, target.username);
    return { userId: target.userId, until: until?.toISOString() ?? null, connections };
  }

  async unban(selector: string): Promise<{ userId: string }> {
    const target = await this.resolve(selector);
    await this.deps.uow.transaction(async (session) => {
      await this.deps.accounts.setBan(target.userId, false, null, null, session);
      await this.deps.audit.record({ userId: target.userId, kind: "UNBAN", meta: { by: "gm" } }, session);
    });
    return { userId: target.userId };
  }

  /** Mutes every chat channel until `until` (null = permanent). Takes effect on the next message. */
  async mute(selector: string, until: Date | null, reason?: string): Promise<{ userId: string; until: string }> {
    const target = await this.resolve(selector);
    const nowMs = this.deps.clock.nowMs();
    const end = until ?? new Date(nowMs + PERMANENT_MS);
    if (end.getTime() <= nowMs) throw new AdminPlayerError("The mute must end in the future.");
    const text = normalize(reason);
    await this.deps.players.setChatMute(target.userId, end, text);
    this.deps.onMuteChanged?.(target.userId);
    await this.deps.audit.record({ userId: target.userId, kind: "GM_MUTE", meta: { reason: text, until: end.toISOString() } });
    return { userId: target.userId, until: end.toISOString() };
  }

  async unmute(selector: string): Promise<{ userId: string }> {
    const target = await this.resolve(selector);
    await this.deps.players.setChatMute(target.userId, null, null);
    this.deps.onMuteChanged?.(target.userId);
    await this.deps.audit.record({ userId: target.userId, kind: "GM_UNMUTE", meta: null });
    return { userId: target.userId };
  }

  /**
   * Sets a currency to an exact balance (credit or debit of the difference) and pushes the wallet to the client. A
   * raise stops at the cap of a currency that cannot overflow (`balance` < `requested`, `clamped` true).
   */
  async setCurrency(selector: string, currencyId: string, amount: number, reason?: string):
    Promise<{ userId: string; currencyId: string; balance: number; requested: number; clamped: boolean; wallet: Record<string, number> }> {
    const target = await this.resolve(selector);
    const id = String(currencyId || "").trim();
    if (!this.deps.currencies.get(id)) throw new AdminPlayerError(`Unknown currency: ${id}`);
    const wanted = Math.max(0, Math.floor(Number(amount) || 0));
    const text = normalize(reason);

    await this.deps.economy.ensureUserCurrencies(target.userId);
    const balance = await this.deps.uow.transaction(async (session) => {
      const current = (await this.deps.ledger.lockedBalances(session, target.userId, [id]))[id] ?? 0;
      const delta = wanted - current;
      let final = current;
      if (delta > 0) final = (await this.deps.ledger.credit(session, target.userId, [{ currencyId: id, amount: delta }]))[id] ?? current;
      if (delta < 0) final = (await this.deps.ledger.debit(session, target.userId, [{ currencyId: id, amount: -delta }]))[id] ?? wanted;
      await this.deps.audit.record({ userId: target.userId, kind: "GM_SET_CURRENCY", meta: { currencyId: id, from: current, to: final, requested: wanted, reason: text } }, session);
      return final;
    });

    const wallet = await this.deps.ledger.snapshot(target.userId);
    await this.deps.notifier.pushPlayerGrant(target.userId, { grantedAt: this.deps.clock.now().toISOString(), reason: text, wallet },
      { targetLabel: target.username, currencyId: id, currencyAmount: balance });
    return { userId: target.userId, currencyId: id, balance, requested: wanted, clamped: balance !== wanted, wallet };
  }

  /** Sets the account level (EXP back to 0, no level-up rewards). The client shows it on the next login. */
  async setLevel(selector: string, level: number, reason?: string): Promise<{ userId: string; level: number }> {
    const target = await this.resolve(selector);
    const max = Math.max(1, this.deps.maxAccountLevel());
    const wanted = Math.floor(Number(level) || 0);
    if (wanted < 1 || wanted > max) throw new AdminPlayerError(`Level must be between 1 and ${max}.`);
    await this.deps.uow.transaction(async (session) => {
      const current = await this.deps.profiles.lockProgress(target.userId, session);
      if (!current) throw new AdminPlayerError("The player has no profile yet.");
      await this.deps.profiles.updateProgress(target.userId, wanted, 0, session);
      await this.deps.audit.record({ userId: target.userId, kind: "GM_SET_LEVEL", meta: { from: current.level, to: wanted, reason: normalize(reason) } }, session);
    });
    return { userId: target.userId, level: wanted };
  }

  /**
   * Forgets story/tutorial sequences so they play again (rewards included, they count as never completed). `scope`:
   * `all`, `tutorial` / `story` (ids starting with `tutorial_` / `story_`) or an explicit id list.
   */
  async resetStory(selector: string, scope: "all" | "tutorial" | "story" | string[]): Promise<{ userId: string; removed: number }> {
    const target = await this.resolve(selector);
    let ids: string[] | null = null;
    if (Array.isArray(scope)) {
      ids = [...new Set(scope.map((id) => String(id).trim()).filter(Boolean))];
      const unknown = ids.filter((id) => !this.deps.knownDialogue(id));
      if (ids.length === 0 || unknown.length > 0) throw new AdminPlayerError(`Unknown dialogue id(s): ${unknown.join(", ") || "(none)"}`);
    } else if (scope !== "all") {
      const detail = await this.deps.players.loadDetail(target.userId);
      ids = (detail?.story.completed ?? []).map((row) => row.dialogueId).filter((id) => id.startsWith(`${scope}_`));
      if (detail?.story.active?.dialogueId.startsWith(`${scope}_`)) ids.push(detail.story.active.dialogueId);
      if (ids.length === 0) return { userId: target.userId, removed: 0 };
    }

    const removed = await this.deps.uow.transaction(async (session) => {
      const count = await this.deps.players.resetStory(target.userId, ids, session);
      await this.deps.audit.record({ userId: target.userId, kind: "GM_RESET_STORY", meta: { scope: Array.isArray(scope) ? ids : scope, removed: count } }, session);
      return count;
    });
    return { userId: target.userId, removed };
  }

  private async resolve(selector: string): Promise<AdminUserRef> {
    const value = String(selector || "").trim();
    if (!value) throw new AdminPlayerError("Player id, username or email is required.");
    const user = await this.deps.users.resolve(value);
    if (!user) throw new AdminPlayerError("Player not found.");
    return user;
  }
}

/** Operator mistakes (unknown player, invalid value): answered as 400 with the message. */
export class AdminPlayerError extends Error {}

function normalize(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim().slice(0, 255) : "";
  return text.length > 0 ? text : null;
}
