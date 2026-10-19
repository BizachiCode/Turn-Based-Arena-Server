// GM panel "Guilds": browse guilds and apply the operator actions the guild module already supports (kick a member,
// transfer the lead, disband, edit name / notice / description). Rules, notices and guild chat lines stay in
// `GuildService`; this service adds the audit trail.

import { AppError } from "../../shared/errors/app-error.js";
import type { AuditLog } from "../../shared/kernel/audit.js";
import type { AdminGuildDetail, AdminGuildList, AdminGuildListQuery, AdminGuildRepository } from "./admin-guilds.ports.js";
import { AdminPlayerError } from "./admin-players.service.js";

/** Operator side of `GuildService`. */
export interface AdminGuildOperator {
  operatorKick(guildId: string, memberId: string): Promise<{ userId: string }>;
  operatorTransfer(guildId: string, memberId: string): Promise<{ userId: string; previousLeaderId: string }>;
  operatorDisband(guildId: string): Promise<{ members: number }>;
  operatorUpdate(guildId: string, input: { name?: string; description?: string; notice?: string }): Promise<void>;
}

export type AdminGuildsDeps = {
  repo: AdminGuildRepository;
  guilds: AdminGuildOperator;
  audit: AuditLog;
};

const clean = (value: unknown): string | null => {
  const text = typeof value === "string" ? value.trim().slice(0, 255) : "";
  return text.length > 0 ? text : null;
};

export class AdminGuildsService {
  constructor(private readonly deps: AdminGuildsDeps) {}

  async list(input: Partial<AdminGuildListQuery>): Promise<AdminGuildList & { page: number; pageSize: number }> {
    const query: AdminGuildListQuery = {
      filter: input.filter ?? "all",
      q: input.q?.trim() || null,
      sort: input.sort ?? "members",
      dir: input.dir ?? "desc",
      page: Math.max(1, Math.floor(input.page ?? 1)),
      pageSize: Math.max(1, Math.min(100, Math.floor(input.pageSize ?? 25))),
    };
    return { ...(await this.deps.repo.list(query)), page: query.page, pageSize: query.pageSize };
  }

  async detail(guildId: string): Promise<AdminGuildDetail> {
    const detail = await this.deps.repo.detail(guildId);
    if (!detail) throw new AdminPlayerError("Guild not found.");
    return detail;
  }

  async kick(guildId: string, memberId: string, reason?: string): Promise<{ userId: string }> {
    const result = await this.run(() => this.deps.guilds.operatorKick(guildId, memberId));
    await this.deps.audit.record({ userId: result.userId, kind: "GM_GUILD_KICK", meta: { guildId, reason: clean(reason) } });
    return result;
  }

  async transfer(guildId: string, memberId: string, reason?: string): Promise<{ userId: string }> {
    const result = await this.run(() => this.deps.guilds.operatorTransfer(guildId, memberId));
    await this.deps.audit.record({
      userId: result.userId,
      kind: "GM_GUILD_LEADER",
      meta: { guildId, previousLeaderId: result.previousLeaderId, reason: clean(reason) },
    });
    return { userId: result.userId };
  }

  async disband(guildId: string, reason?: string): Promise<{ members: number }> {
    const name = (await this.deps.repo.detail(guildId))?.guild.name ?? null;
    const result = await this.run(() => this.deps.guilds.operatorDisband(guildId));
    await this.deps.audit.record({ userId: null, kind: "GM_GUILD_DISBAND", meta: { guildId, name, members: result.members, reason: clean(reason) } });
    return result;
  }

  async update(guildId: string, input: { name?: string; description?: string; notice?: string }, reason?: string): Promise<AdminGuildDetail> {
    if (input.name === undefined && input.description === undefined && input.notice === undefined) throw new AdminPlayerError("Nothing to change.");
    await this.run(() => this.deps.guilds.operatorUpdate(guildId, input));
    await this.deps.audit.record({ userId: null, kind: "GM_GUILD_EDIT", meta: { guildId, fields: Object.keys(input), reason: clean(reason) } });
    return this.detail(guildId);
  }

  /** Guild rule violations are operator mistakes: answered with the code as a readable message. */
  private async run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof AppError) throw new AdminPlayerError(error.errorCode);
      throw error;
    }
  }
}
