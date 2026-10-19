// Room tests with @colyseus/testing: a test server with only the rooms under test, a fake access authenticator
// (`token-<userId>` -> that user) and an allow-all limiter.

import { boot, type ColyseusTestServer } from "@colyseus/testing";
import { defineRoom, defineServer } from "@colyseus/core";
import type { Room as SdkRoom } from "@colyseus/sdk";

import type { AccessAuthenticator, AuthenticatedIdentity } from "../../src/shared/security/access-authenticator";
import type { RateLimiter } from "../../src/shared/security/rate-limiter";
import { configureRoomAuthentication } from "../../src/shared/rooms/authenticated-room";

export const allowAll: RateLimiter = { allow: () => true };

/** Users whose sessions were revoked (their requests fail with UNAUTHORIZED). */
export const revokedUsers = new Set<string>();

export const fakeAuthenticator = {
  async authenticate(token?: string | null): Promise<AuthenticatedIdentity | null> {
    const match = /^token-(.+)$/.exec(token ?? "");
    if (!match || revokedUsers.has(match[1])) return null;
    return { userId: match[1], username: match[1], deviceId: `device-${match[1]}`, accessJti: `jti-${match[1]}` };
  },
  async isSessionActive(identity: AuthenticatedIdentity): Promise<boolean> {
    return !revokedUsers.has(identity.userId);
  },
} as unknown as AccessAuthenticator;

export function tokenOf(userId: string): string {
  return `token-${userId}`;
}

/** Boots a test server with the given (already bound) room classes. */
export async function bootRooms(rooms: Record<string, new () => any>): Promise<ColyseusTestServer> {
  configureRoomAuthentication(fakeAuthenticator);
  const definitions = Object.fromEntries(Object.entries(rooms).map(([name, room]) => [name, defineRoom(room)]));
  return boot(defineServer({ rooms: definitions, greet: false } as any));
}

/** Drops the socket without leaving (no automatic reconnection by the SDK): the server sees `onDrop`. */
export function dropConnection(room: SdkRoom): void {
  room.reconnection.enabled = false;
  room.connection.close(1000, "network lost");
}

export function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 4000, stepMs = 20, label = ""): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        if (await condition()) return resolve();
      } catch {
        // keep polling
      }
      if (Date.now() > deadline) return reject(new Error(`waitFor timed out${label ? ` (${label})` : ""}`));
      setTimeout(tick, stepMs);
    };
    void tick();
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
