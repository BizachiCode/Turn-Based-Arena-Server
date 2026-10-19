// In-memory guild repository shared by the guild service tests (mirrors the Drizzle one).

import type { GuildRole } from "../../src/modules/guild/guild.domain";
import type {
  GuildApplicantRow,
  GuildListRow,
  GuildMemberProfile,
  GuildMemberRecord,
  GuildOwnRequestRow,
  GuildPatch,
  GuildRecord,
  GuildRepository,
  GuildRequestRecord,
  PlayerProfileRow,
} from "../../src/modules/guild/guild.ports";
import type { FixedClock } from "../../src/shared/kernel/clock";
import { duplicateKeyError } from "./fakes";

type RepoState = {
  guilds: Map<string, GuildRecord & { nameKey: string }>;
  members: Map<string, GuildMemberRecord>;
  requests: Map<string, GuildRequestRecord>;
};

export class InMemoryGuildRepository implements GuildRepository {
  state: RepoState = { guilds: new Map(), members: new Map(), requests: new Map() };
  profiles = new Map<string, PlayerProfileRow>();
  online = new Set<string>();

  constructor(private readonly clock: FixedClock) {}

  snapshot(): unknown { return structuredClone(this.state); }
  restore(state: unknown): void { this.state = state as RepoState; }

  private leaderName(guildId: string): string {
    const leader = [...this.state.members.values()].find((member) => member.guildId === guildId && member.role === "leader");
    return leader ? this.profiles.get(leader.userId)?.name ?? "" : "";
  }

  private row(guild: GuildRecord): GuildListRow {
    const { nameKey: _key, ...record } = guild as GuildRecord & { nameKey: string };
    return { ...structuredClone(record), leaderName: this.leaderName(guild.id) };
  }

  async findMembership(userId: string) { const member = this.state.members.get(userId); return member ? { ...member } : null; }
  async findMemberByPublicId(guildId: string, publicId: string) {
    const member = [...this.state.members.values()].find((entry) => entry.guildId === guildId && entry.publicId === publicId);
    return member ? { ...member } : null;
  }
  async listMembers(guildId: string) {
    return [...this.state.members.values()].filter((member) => member.guildId === guildId)
      .sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime()).map((member) => ({ ...member }));
  }
  async listMemberProfiles(guildId: string): Promise<GuildMemberProfile[]> {
    return (await this.listMembers(guildId)).map((member) => ({
      ...member,
      ...(this.profiles.get(member.userId) ?? { name: "?", level: 1, iconId: "" }),
      lastActiveAt: null,
      online: this.online.has(member.userId),
    }));
  }
  async insertMember(member: Omit<GuildMemberRecord, "joinedAt">) {
    if (this.state.members.has(member.userId)) throw duplicateKeyError();
    // Strictly increasing join dates keep the member order deterministic.
    this.state.members.set(member.userId, { ...member, joinedAt: new Date(this.clock.nowMs() + this.state.members.size) });
  }
  async deleteMember(userId: string) { this.state.members.delete(userId); }
  async setRole(userId: string, role: GuildRole) { this.state.members.get(userId)!.role = role; }

  async findGuild(guildId: string) { const guild = this.state.guilds.get(guildId); return guild ? structuredClone(guild) : null; }
  async findGuildRow(guildId: string) { const guild = this.state.guilds.get(guildId); return guild ? this.row(guild) : null; }
  async isNameTaken(nameKey: string) { return [...this.state.guilds.values()].some((guild) => guild.nameKey === nameKey); }
  async insertGuild(guild: Omit<GuildRecord, "createdAt" | "memberCount"> & { nameKey: string; memberCount: number }) {
    if (await this.isNameTaken(guild.nameKey)) throw duplicateKeyError();
    this.state.guilds.set(guild.id, { ...structuredClone(guild), createdAt: this.clock.now() });
  }
  async updateGuild(guildId: string, patch: GuildPatch) { Object.assign(this.state.guilds.get(guildId)!, structuredClone(patch)); }
  async renameGuild(guildId: string, name: string, nameKey: string) {
    if ([...this.state.guilds.values()].some((guild) => guild.id !== guildId && guild.nameKey === nameKey)) throw duplicateKeyError();
    Object.assign(this.state.guilds.get(guildId)!, { name, nameKey });
  }
  async addMemberCount(guildId: string, delta: number) { const guild = this.state.guilds.get(guildId)!; guild.memberCount = Math.max(0, guild.memberCount + delta); }
  async deleteGuild(guildId: string) {
    this.state.guilds.delete(guildId);
    for (const [userId, member] of this.state.members) if (member.guildId === guildId) this.state.members.delete(userId);
    for (const [id, request] of this.state.requests) if (request.guildId === guildId) this.state.requests.delete(id);
  }
  async listGuilds(filter: { search: string | null; limit: number }) {
    return [...this.state.guilds.values()]
      .filter((guild) => !filter.search || guild.nameKey.includes(filter.search.toLowerCase()))
      .slice(0, filter.limit).map((guild) => this.row(guild));
  }

  async findRequest(requestId: string) { const request = this.state.requests.get(requestId); return request ? { ...request } : null; }
  async findRequestFor(guildId: string, userId: string) {
    const request = [...this.state.requests.values()].find((entry) => entry.guildId === guildId && entry.userId === userId);
    return request ? { ...request } : null;
  }
  async insertRequest(request: Omit<GuildRequestRecord, "createdAt">) {
    if (await this.findRequestFor(request.guildId, request.userId)) throw duplicateKeyError();
    this.state.requests.set(request.id, { ...request, createdAt: this.clock.now() });
  }
  async deleteRequest(requestId: string) { this.state.requests.delete(requestId); }
  async deleteRequestsOfUser(userId: string) {
    for (const [id, request] of this.state.requests) if (request.userId === userId) this.state.requests.delete(id);
  }
  async deleteExpiredRequestsOfUser(userId: string, before: Date) {
    for (const [id, request] of this.state.requests) if (request.userId === userId && request.createdAt < before) this.state.requests.delete(id);
  }
  async countRequestsOfUser(userId: string, since: Date) {
    return [...this.state.requests.values()].filter((request) => request.userId === userId && request.createdAt >= since).length;
  }
  async listRequestsOfUser(userId: string, since: Date): Promise<GuildOwnRequestRow[]> {
    return [...this.state.requests.values()].filter((request) => request.userId === userId && request.createdAt >= since).map((request) => {
      const guild = this.state.guilds.get(request.guildId)!;
      return { guildId: guild.id, name: guild.name, iconId: guild.iconId, memberCount: guild.memberCount, createdAt: request.createdAt };
    });
  }
  async listRequestsOfGuild(guildId: string, since: Date): Promise<GuildApplicantRow[]> {
    return [...this.state.requests.values()].filter((request) => request.guildId === guildId && request.createdAt >= since).map((request) => ({
      id: request.id,
      ...(this.profiles.get(request.userId) ?? { name: "?", level: 1, iconId: "" }),
      createdAt: request.createdAt,
    }));
  }
  async countRequestsOfGuild(guildId: string, since: Date) { return (await this.listRequestsOfGuild(guildId, since)).length; }
  async profileOf(userId: string) { const profile = this.profiles.get(userId); return profile ? { ...profile } : null; }
}
