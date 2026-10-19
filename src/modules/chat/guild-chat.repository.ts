import { and, desc, eq, lt } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/drizzle.js";
import { DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { guildChatMessages } from "../../infrastructure/database/schema/index.js";
import type { GuildChatRepository, GuildChatRow, NewGuildChatRow } from "./guild-chat.ports.js";

export class DrizzleGuildChatRepository extends DrizzleRepository implements GuildChatRepository {
  constructor(database: Database) {
    super(database);
  }

  async insertMessage(row: NewGuildChatRow, capPerGuild: number): Promise<number> {
    const [inserted] = await this.database.insert(guildChatMessages).values({
      guildId: row.guildId,
      userId: row.userId,
      kind: row.kind,
      nickname: row.sender.nickname.substring(0, 32),
      iconId: row.sender.iconId,
      level: row.sender.level,
      message: row.message,
      originalMessage: row.original ?? null,
    }).$returningId();

    // Keep only the newest `capPerGuild` lines of the guild.
    const [oldestKept] = await this.database.select({ id: guildChatMessages.id }).from(guildChatMessages)
      .where(eq(guildChatMessages.guildId, row.guildId))
      .orderBy(desc(guildChatMessages.id))
      .limit(1)
      .offset(Math.max(0, capPerGuild - 1));
    if (oldestKept) {
      await this.database.delete(guildChatMessages)
        .where(and(eq(guildChatMessages.guildId, row.guildId), lt(guildChatMessages.id, oldestKept.id)));
    }
    return Number(inserted?.id ?? 0);
  }

  async fetchHistory(guildId: string, limit: number): Promise<GuildChatRow[]> {
    const rows = await this.database
      .select({
        id: guildChatMessages.id,
        guildId: guildChatMessages.guildId,
        userId: guildChatMessages.userId,
        kind: guildChatMessages.kind,
        nickname: guildChatMessages.nickname,
        iconId: guildChatMessages.iconId,
        level: guildChatMessages.level,
        message: guildChatMessages.message,
        originalMessage: guildChatMessages.originalMessage,
        createdAt: guildChatMessages.createdAt,
      })
      .from(guildChatMessages)
      .where(eq(guildChatMessages.guildId, guildId))
      .orderBy(desc(guildChatMessages.id))
      .limit(Math.max(1, Math.min(200, limit)));
    return rows.reverse();
  }
}
