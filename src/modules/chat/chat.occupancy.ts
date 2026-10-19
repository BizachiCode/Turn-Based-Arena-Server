import type { ChatChannelInfoDto, ChatOccupancyUpdateDto } from "./chat.dto.js";

export const CHAT_OCCUPANCY_TOPIC = "chat:occ:update";

/** Anything able to publish on a presence channel (Colyseus `room.presence`). */
export type PresencePublisher = { publish(topic: string, payload: string): unknown };

/**
 * Players per chat channel in this process. Updates are published on {@link CHAT_OCCUPANCY_TOPIC}
 * so `chat_directory` rooms can push live counts.
 * Only channels with at least one player are kept: a channel is counted from a successful join (never from a room being
 * created) and forgotten when its last player leaves or its room is disposed, so abandoned rooms leave no entries.
 */
export class ChatOccupancy {
  private readonly channels = new Map<number, number>();

  /** Channels with players, sorted by channel number. */
  snapshot(): ChatChannelInfoDto[] {
    return [...this.channels.entries()]
      .filter(([, players]) => players > 0)
      .map(([channel, players]) => ({ channel, players }))
      .sort((left, right) => left.channel - right.channel);
  }

  /** Players currently counted in the channel. */
  count(channel: number): number {
    return this.channels.get(channel) || 0;
  }

  /** Forgets a channel without players (its room was disposed); a channel that still has players is kept. */
  release(channel: number): void {
    if ((this.channels.get(channel) || 0) <= 0) this.channels.delete(channel);
  }

  increment(presence: PresencePublisher | undefined, channel: number): number {
    const next = (this.channels.get(channel) || 0) + 1;
    this.channels.set(channel, next);
    this.publish(presence, { channel, players: next });
    return next;
  }

  decrement(presence: PresencePublisher | undefined, channel: number): number {
    const next = Math.max(0, (this.channels.get(channel) || 1) - 1);
    if (next === 0) this.channels.delete(channel);
    else this.channels.set(channel, next);
    this.publish(presence, { channel, players: next });
    return next;
  }

  private publish(presence: PresencePublisher | undefined, update: ChatOccupancyUpdateDto): void {
    try {
      presence?.publish(CHAT_OCCUPANCY_TOPIC, JSON.stringify(update));
    } catch {
      // directory updates are best effort
    }
  }
}
