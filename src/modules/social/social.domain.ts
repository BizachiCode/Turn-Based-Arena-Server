// Pure rules and DTO shapes of the social layer (friends, private messages, friendly battles).

import type { FriendshipRecord, PlayerSummary } from "./social.ports.js";

/** Same key for both orders of a pair: lower id + ":" + higher id. */
export function pairKeyOf(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/** The other player of a friendship row. */
export function otherOf(record: Pick<FriendshipRecord, "requesterId" | "addresseeId">, userId: string): string {
  return record.requesterId === userId ? record.addresseeId : record.requesterId;
}

export type PlayerStatus = "offline" | "online" | "in_battle";

/** How the viewer relates to a player. */
export type Relation = "self" | "none" | "friend" | "pending_in" | "pending_out" | "blocked";

export function relationOf(viewerId: string, targetId: string, friendship: FriendshipRecord | null, viewerBlocked: boolean): Relation {
  if (viewerId === targetId) return "self";
  if (viewerBlocked) return "blocked";
  if (!friendship) return "none";
  if (friendship.status === "accepted") return "friend";
  return friendship.requesterId === viewerId ? "pending_out" : "pending_in";
}

export type PlayerStatusInfo = { status: PlayerStatus; lastSeenUnix: number | null };

export const OFFLINE: PlayerStatusInfo = { status: "offline", lastSeenUnix: null };

/** A player as listed in search results, requests, profiles and the friends list. */
export type PlayerCardDto = {
  userId: string;
  name: string;
  iconId: string | null;
  level: number;
  status: PlayerStatus;
  /** Newest presence heartbeat (null = never seen, or online now). */
  lastSeenUnix: number | null;
  relation: Relation;
};

export function playerCard(player: PlayerSummary, info: PlayerStatusInfo, relation: Relation): PlayerCardDto {
  return {
    userId: player.userId,
    name: player.name,
    iconId: player.iconId,
    level: player.level,
    status: info.status,
    lastSeenUnix: info.status === "offline" ? info.lastSeenUnix : null,
    relation,
  };
}

export type FriendDto = PlayerCardDto & {
  /** When the friendship was accepted. */
  friendsSinceUnix: number;
  /** Unread private messages from this friend. */
  unread: number;
};

export type FriendRequestDto = {
  requestId: string;
  direction: "incoming" | "outgoing";
  createdAtUnix: number;
  player: PlayerCardDto;
};

export const toUnix = (date: Date | null | undefined): number => (date ? Math.floor(date.getTime() / 1000) : 0);

/** Friends first by status (in battle / online / offline), then by name. */
export function compareFriends(a: PlayerCardDto, b: PlayerCardDto): number {
  const rank = (status: PlayerStatus) => (status === "online" ? 0 : status === "in_battle" ? 1 : 2);
  return rank(a.status) - rank(b.status) || a.name.localeCompare(b.name);
}
