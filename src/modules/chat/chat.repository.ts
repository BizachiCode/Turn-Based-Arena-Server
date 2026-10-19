import { and, desc, eq, lt } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/drizzle.js";
import { DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { chatMessages } from "../../infrastructure/database/schema/index.js";
import type { ChatRow, ChatSenderDto } from "./chat.dto.js";
import type { ChatRepository } from "./chat.ports.js";

export class DrizzleChatRepository extends DrizzleRepository implements ChatRepository {
  constructor(database: Database) {
    super(database);
  }

  async insertMessage(channel: number, userId: string, sender: ChatSenderDto, message: string, capPerChannel: number, original: string | null = null): Promise<number> {
    const [inserted] = await this.database.insert(chatMessages).values({
      channel,
      userId,
      nickname: sender.nickname,
      iconId: sender.iconId,
      level: sender.level,
      message,
      originalMessage: original,
    }).$returningId();

    // Keep only the newest `capPerChannel` messages of the channel.
    const [oldestKept] = await this.database.select({ id: chatMessages.id }).from(chatMessages)
      .where(eq(chatMessages.channel, channel))
      .orderBy(desc(chatMessages.id))
      .limit(1)
      .offset(Math.max(0, capPerChannel - 1));
    if (oldestKept) {
      await this.database.delete(chatMessages).where(and(eq(chatMessages.channel, channel), lt(chatMessages.id, oldestKept.id)));
    }
    return Number(inserted?.id ?? 0);
  }

  async fetchHistory(channel: number, limit: number): Promise<ChatRow[]> {
    const rows = await this.database
      .select({
        id: chatMessages.id,
        channel: chatMessages.channel,
        user_id: chatMessages.userId,
        nickname: chatMessages.nickname,
        icon_id: chatMessages.iconId,
        level: chatMessages.level,
        message: chatMessages.message,
        original_message: chatMessages.originalMessage,
        created_at: chatMessages.createdAt,
      })
      .from(chatMessages)
      .where(eq(chatMessages.channel, channel))
      .orderBy(desc(chatMessages.id))
      .limit(Math.max(1, Math.min(200, limit)));
    return rows.reverse();
  }
}
