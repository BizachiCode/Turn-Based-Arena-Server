import { matchMaker } from "@colyseus/core";

import { AppCloseCode } from "../protocol/close-codes.js";

/**
 * "User revoked" event: published on the Colyseus presence pub/sub whenever a player's sessions were revoked (ban, GM
 * kick, logout, logout of other devices, password change, deletion request). Every `AuthenticatedRoom` of every process
 * listens to it and drops the connections of that user whose session is no longer active, so a revoked session stops
 * receiving pushes (chat lines, mail notices...) at once instead of at its next request.
 */
export const USER_REVOKED_TOPIC = "auth:user_revoked";

/** Anything able to publish on a presence channel (Colyseus `room.presence` / `matchMaker.presence`). */
export type RevocationPublisher = { publish(topic: string, payload: string): unknown };

let publisherSource: () => RevocationPublisher | undefined = () => matchMaker.presence;

/** Replaces where events are published (tests); the default is `matchMaker.presence`, read lazily. */
export function configureUserRevocation(source: () => RevocationPublisher | undefined): void {
  publisherSource = source;
}

/** Tells every room that the sessions of `userId` changed. Best effort: failures never undo the revocation. */
export function notifyUserRevoked(userId: string): void {
  if (!userId) return;
  try {
    void Promise.resolve(publisherSource()?.publish(USER_REVOKED_TOPIC, JSON.stringify({ userId }))).catch((): void => undefined);
  } catch {
    // the connections still die at their next request / heartbeat
  }
}

/** Presence able to (un)subscribe a topic (Colyseus `room.presence`). */
export type RevocationSubscriber = {
  subscribe(topic: string, callback: (raw: unknown) => void): unknown;
  unsubscribe(topic: string, callback?: (raw: unknown) => void): unknown;
};

let subscriberSource: () => RevocationSubscriber | undefined = () => matchMaker.presence;

/**
 * Replaces the process-wide presence rooms subscribe through (tests); the default is `matchMaker.presence`, read lazily.
 * A room falls back to its own presence when the source has none (before the server is set up).
 */
export function configureRevocationSubscriber(source: () => RevocationSubscriber | undefined): void {
  subscriberSource = source;
}

/** The presence rooms share their revocation subscription on (undefined before the server is set up). */
export function revocationSubscriber(): RevocationSubscriber | undefined {
  return subscriberSource();
}

type RevocationHub = { handlers: Set<(raw: unknown) => void>; dispatch: (raw: unknown) => void };
const hubs = new WeakMap<object, RevocationHub>();

/**
 * Registers a room's revocation handler. Every room of a process shares ONE presence subscription (per presence
 * instance): subscribing once per room added one EventEmitter listener per room (MaxListenersExceededWarning with
 * more than 10 rooms, thousands of listeners with one battle room per player). Returns the unregister function; the
 * subscription is dropped when the last room unregisters.
 */
export function registerRevocationHandler(presence: RevocationSubscriber, handler: (raw: unknown) => void): () => void {
  let hub = hubs.get(presence);
  if (!hub) {
    const handlers = new Set<(raw: unknown) => void>();
    const dispatch = (raw: unknown): void => {
      for (const current of [...handlers]) {
        try {
          current(raw);
        } catch {
          // one room failing never stops the others
        }
      }
    };
    hub = { handlers, dispatch };
    hubs.set(presence, hub);
    void Promise.resolve(presence.subscribe(USER_REVOKED_TOPIC, dispatch)).catch((): void => undefined);
  }
  const active = hub;
  active.handlers.add(handler);
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    active.handlers.delete(handler);
    if (active.handlers.size > 0 || hubs.get(presence) !== active) return;
    hubs.delete(presence);
    void Promise.resolve(presence.unsubscribe(USER_REVOKED_TOPIC, active.dispatch)).catch((): void => undefined);
  };
}

/** User id carried by a revocation event (null when malformed). */
export function parseUserRevoked(raw: unknown): string | null {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : Buffer.isBuffer(raw) ? JSON.parse(raw.toString()) : raw;
    const userId = (value as { userId?: unknown } | null)?.userId;
    return typeof userId === "string" && userId ? userId : null;
  } catch {
    return null;
  }
}

/** A connection as seen by {@link closeRevokedClients}. */
export type RevocableClient = { auth?: unknown; leave(code?: number, data?: string): void };

/**
 * Closes (`SESSION_REVOKED`) the connections of `userId` whose session is no longer active. Connections that are still
 * valid stay (logout of other devices and password change keep the calling device), and a failing session lookup never
 * closes anything. Returns the number of connections closed.
 */
export async function closeRevokedClients<TClient extends RevocableClient>(
  clients: Iterable<TClient>,
  userId: string,
  isActive: (client: TClient) => Promise<boolean>,
): Promise<number> {
  const candidates = [...clients].filter((client) => (client.auth as { userId?: string } | undefined)?.userId === userId);
  const results = await Promise.all(candidates.map(async (client) => {
    try {
      if (await isActive(client)) return false;
    } catch {
      return false;
    }
    client.leave(AppCloseCode.SESSION_REVOKED, "session revoked");
    return true;
  }));
  return results.filter(Boolean).length;
}
