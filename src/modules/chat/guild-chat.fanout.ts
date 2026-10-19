import type { PresencePublisher } from "./chat.occupancy.js";
import type { GuildChatFanout, GuildChatFanoutEvent } from "./guild-chat.ports.js";

/** Presence topic listened to by every `guild_chat` room (Redis presence spreads it to every process). */
export const GUILD_CHAT_TOPIC = "guild_chat:events";

/** {@link GuildChatFanout} over the Colyseus presence pub/sub (`matchMaker.presence`, read lazily at publish time). */
export class PresenceGuildChatFanout implements GuildChatFanout {
  constructor(private readonly presence: () => PresencePublisher | undefined) {}

  publish(event: GuildChatFanoutEvent): void {
    this.presence()?.publish(GUILD_CHAT_TOPIC, JSON.stringify(event));
  }
}

/** A live `guild_chat` connection as seen by the router (the room adapts its Colyseus clients). */
export interface GuildChatConnection {
  readonly userId: string;
  /** Guild channel the connection currently receives (null = none). */
  guildId: string | null;
  send(type: "guild_chat_msg" | "guild_chat_state", payload: unknown): void;
}

/**
 * Applies one fanout event to the room's connections: a `message` reaches only the connections of that guild (with a
 * per-recipient `self` flag); a `membership` change moves the player's connections to their new guild channel (or
 * none) and pushes `guild_chat_state`.
 */
export function routeGuildChatEvent(
  event: GuildChatFanoutEvent,
  connections: Iterable<GuildChatConnection>,
  serverTimeUnix: number,
): void {
  for (const connection of connections) {
    if (event.type === "message") {
      if (!connection.guildId || connection.guildId !== event.guildId) continue;
      connection.send("guild_chat_msg", { ...event.message, self: !!event.senderUserId && event.senderUserId === connection.userId });
      continue;
    }

    if (connection.userId !== event.userId) continue;
    connection.guildId = event.guildId;
    connection.send("guild_chat_state", {
      inGuild: !!event.guildId,
      guildId: event.guildId,
      guildName: event.guildName,
      serverTimeUnix,
    });
  }
}

/** Parses a fanout payload received from the presence (null when malformed). */
export function parseGuildChatEvent(raw: unknown): GuildChatFanoutEvent | null {
  try {
    const event = typeof raw === "string" ? JSON.parse(raw) : Buffer.isBuffer(raw) ? JSON.parse(raw.toString()) : raw;
    if (!event || typeof event !== "object") return null;
    if (event.type === "message" && typeof event.guildId === "string" && event.message) return event as GuildChatFanoutEvent;
    if (event.type === "membership" && typeof event.userId === "string") return event as GuildChatFanoutEvent;
    return null;
  } catch {
    return null;
  }
}
