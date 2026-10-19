import type { DbSession } from "../../shared/kernel/unit-of-work.js";

/** What other players may see of a player (never the email, account name or internal flags). */
export type PlayerSummary = {
  userId: string;
  name: string;
  iconId: string | null;
  level: number;
};

/** Connection state of a player: an open presence connection with a recent heartbeat, and the newest heartbeat. */
export type PlayerConnection = { online: boolean; lastSeenAt: Date | null };

/** Read model of players shared by friends, private messages and friendly battles. */
export interface PlayerDirectory {
  findPlayer(userId: string): Promise<PlayerSummary | null>;
  /** Exact profile name (names are unique, compared like the database collation). */
  findPlayerByName(name: string): Promise<PlayerSummary | null>;
  findPlayers(userIds: readonly string[]): Promise<PlayerSummary[]>;
  /** Players whose profile name starts with `prefix` (shortest names first). */
  searchByNamePrefix(prefix: string, limit: number): Promise<PlayerSummary[]>;
  /** Presence connections of the players (`onlineSince`: oldest heartbeat that still counts as online). */
  connectionsOf(userIds: readonly string[], onlineSince: Date): Promise<Map<string, PlayerConnection>>;
  guildOf(userId: string): Promise<{ guildId: string; guildName: string } | null>;
  arenaOf(userId: string): Promise<{ rating: number; wins: number; losses: number } | null>;
}

export type FriendshipStatus = "pending" | "accepted";

export type FriendshipRecord = {
  id: string;
  requesterId: string;
  addresseeId: string;
  status: FriendshipStatus;
  createdAt: Date;
  respondedAt: Date | null;
};

/** Persistence port of friendships and blocks. */
export interface FriendsRepository {
  /** Row locks on both players (lower id first): serializes friend counts and pair changes of the two players. */
  lockPlayers(userIds: readonly string[], session: DbSession): Promise<void>;
  findBetween(a: string, b: string, session?: DbSession): Promise<FriendshipRecord | null>;
  findById(id: string, session?: DbSession): Promise<FriendshipRecord | null>;
  /** Inserts a pending request (the unique pair key makes a second row for the same pair fail). */
  insertRequest(record: FriendshipRecord, session: DbSession): Promise<void>;
  accept(id: string, at: Date, session: DbSession): Promise<void>;
  delete(id: string, session: DbSession): Promise<void>;
  /** Rows involving the player (`status` filter optional), newest first. */
  listOf(userId: string, status?: FriendshipStatus): Promise<FriendshipRecord[]>;
  countFriends(userId: string, session?: DbSession): Promise<number>;
  countPending(userId: string, direction: "outgoing" | "incoming", session?: DbSession): Promise<number>;

  isBlocked(blockerId: string, blockedId: string, session?: DbSession): Promise<boolean>;
  insertBlock(blockerId: string, blockedId: string, session: DbSession): Promise<void>;
  deleteBlock(blockerId: string, blockedId: string, session: DbSession): Promise<boolean>;
  listBlocked(blockerId: string): Promise<Array<{ userId: string; createdAt: Date }>>;
  countBlocked(blockerId: string, session?: DbSession): Promise<number>;
}

/** Unread private messages per peer (the friends list shows them next to each friend). */
export interface UnreadMessages {
  unreadByPeer(userId: string): Promise<Map<string, number>>;
}

/** Pushed to a player's presence connections as `social_event` (best effort; clients re-sync with the requests). */
export type SocialEvent = { kind: string } & Record<string, unknown>;

export interface SocialNotifier {
  notify(userId: string, event: SocialEvent): void | Promise<void>;
}

export const noSocialNotifier: SocialNotifier = { notify: () => undefined };
