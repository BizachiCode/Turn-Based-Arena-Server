import type { DbSession } from "../../shared/kernel/unit-of-work.js";

export type FriendlyMatchStatus = "pending" | "accepted" | "declined" | "cancelled" | "expired" | "finished" | "aborted";

/** A friendly battle: the challenge and, once accepted, the match. */
export type FriendlyMatchRecord = {
  id: string;
  challengerId: string;
  targetId: string;
  status: FriendlyMatchStatus;
  roomId: string | null;
  winnerId: string | null;
  finishedReason: string | null;
  createdAt: Date;
  expiresAt: Date;
  respondedAt: Date | null;
  finishedAt: Date | null;
};

export type FriendlyMatchPatch = {
  respondedAt?: Date;
  roomId?: string;
  winnerId?: string | null;
  finishedReason?: string;
  finishedAt?: Date;
  result?: unknown;
};

export interface FriendlyMatchRepository {
  insert(record: FriendlyMatchRecord, session: DbSession): Promise<void>;
  findById(id: string, session?: DbSession, forUpdate?: boolean): Promise<FriendlyMatchRecord | null>;
  /** Pending challenges (either direction) and accepted matches of the player, newest first. */
  listOpen(userId: string): Promise<FriendlyMatchRecord[]>;
  /** Pending challenges sent by the player. */
  pendingFrom(challengerId: string, session?: DbSession): Promise<FriendlyMatchRecord[]>;
  /** Pending challenges between the two players, either direction. */
  pendingBetween(a: string, b: string, session?: DbSession): Promise<FriendlyMatchRecord[]>;
  /** Pending challenges of these players whose time ran out become `expired`. */
  expireStale(userIds: readonly string[], now: Date): Promise<void>;
  /** Moves the row to `to` only while its status is one of `from` (compare and set); false when it was not. */
  transition(id: string, from: readonly FriendlyMatchStatus[], to: FriendlyMatchStatus, patch: FriendlyMatchPatch, session?: DbSession): Promise<boolean>;
}
