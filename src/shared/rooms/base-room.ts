import { Room, ServerError, type Client } from "@colyseus/core";
import { Schema } from "@colyseus/schema";

import { createLogger, type Logger } from "../logger.js";
import { clientAddress } from "./client-address.js";
import { connectionRegistry } from "./connection-limits.js";
import { executeRequest, type RequestSpec, type ResponseBody } from "./request-handler.js";

/** Context passed to request handlers of rooms that don't require authentication. */
export type AnonymousRequestContext = {
  client: Client;
  /** Best-effort remote address, used as rate-limit key. */
  address: string;
};

/**
 * Base class for every game room.
 * - Dependencies are injected by the composition root through {@link bindRoom} (Colyseus creates
 *   room instances itself, so constructor arguments aren't available).
 * - Request handlers are registered with {@link handleRequest}: they validate with zod, return the
 *   response (Colyseus request/response) and map errors to `{ ok: false, error }` uniformly.
 */
export abstract class BaseRoom<TState extends Schema = Schema, TDeps = unknown> extends Room<{ state: TState }> {
  /** Injected by {@link bindRoom}. */
  protected deps!: TDeps;

  protected readonly logger: Logger = createLogger(this.constructor.name);

  /** Runs right before the room's `onCreate` (wired by {@link bindRoom}); subclasses of the shared bases hook in here. */
  protected onRoomReady(): void {}

  /** Runs right before the room's `onDispose` (wired by {@link bindRoom}). */
  protected onRoomClosing(): void {}

  /** Registers a request handler for anonymous rooms (auth, directories). */
  protected handleRequest<TPayload>(type: string, spec: RequestSpec<TPayload, AnonymousRequestContext>): void {
    this.onMessage(type, (client, rawPayload, messageContext) =>
      executeRequest<TPayload, AnonymousRequestContext>({
        type,
        rawPayload,
        messageContext,
        spec,
        logger: this.logger,
        rateLimitKey: addressOf(client),
        resolveContext: async () => ({ client, address: addressOf(client) }),
      }),
    );
  }
}

/**
 * Rate-limit key of a client: its network address (socket peer, or the forwarded address when `TRUST_PROXY` is on; see
 * `client-address.ts`), falling back to the sessionId when the transport doesn't expose one.
 */
export function addressOf(client: Client): string {
  return String(clientAddress(client) || client.sessionId || "unknown");
}

/** Dependency bag declared by a room class (`BaseRoom<State, Deps>`). */
export type RoomDependencies<TRoom> = TRoom extends BaseRoom<any, infer TDeps> ? TDeps : never;

/**
 * Creates a concrete room class with its dependencies bound. The returned class keeps the original
 * name and static members (e.g. `onAuth`), so it can be passed straight to `defineRoom()`.
 */
export function bindRoom<TRoom extends BaseRoom<any, any>>(
  RoomClass: new () => TRoom,
  deps: RoomDependencies<TRoom>,
): new () => TRoom {
  const Base = RoomClass as unknown as new () => BaseRoom<any, RoomDependencies<TRoom>>;
  /** Sessions refused by the connection cap: their (framework-triggered) onLeave must not reach the room's own handler. */
  const refused = new WeakSet<object>();

  class BoundRoom extends Base {
    constructor() {
      super();
      this.deps = deps;
    }

    /** Per-account connection cap (MAX_CONNECTIONS_PER_USER): runs before the room's own onJoin. */
    onJoin(client: Client, options?: unknown, auth?: unknown): void | Promise<void> {
      const userId = (client.auth as { userId?: unknown } | undefined)?.userId;
      if (typeof userId === "string" && userId && !connectionRegistry.tryAcquire(client.sessionId, userId, this.roomName)) {
        refused.add(client);
        throw new ServerError(429, "TOO_MANY_CONNECTIONS");
      }
      // Not async on purpose: rooms whose onJoin throws synchronously keep doing so.
      return (super.onJoin as ((c: Client, o?: unknown, a?: unknown) => void | Promise<void>) | undefined)?.call(this, client, options, auth);
    }

    onLeave(client: Client, code?: number): void | Promise<void> {
      connectionRegistry.release(client.sessionId);
      if (refused.has(client)) return;
      return (super.onLeave as ((c: Client, code?: number) => void | Promise<void>) | undefined)?.call(this, client, code);
    }

    async onCreate(options: any): Promise<void> {
      this.onRoomReady();
      await super.onCreate?.(options);
    }

    async onDispose(): Promise<void> {
      try {
        this.onRoomClosing();
      } finally {
        await super.onDispose?.();
      }
    }
  }
  Object.defineProperty(BoundRoom, "name", { value: RoomClass.name });
  return BoundRoom as unknown as new () => TRoom;
}

export type { ResponseBody };
