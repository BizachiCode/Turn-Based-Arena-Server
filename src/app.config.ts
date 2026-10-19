// Colyseus server definition: rooms, HTTP routes and boot hooks (wired from the composition root).

import { defineRoom, defineServer } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";

import { createContainer } from "./app/container.js";
import { configureHttp, configureMatchmakingCors, guardMatchmakeErrorCodes, installRequestGuard } from "./app/http.js";
import { db } from "./infrastructure/database/drizzle.js";
import { redis } from "./infrastructure/database/redis.js";
import { serverRuntimeState } from "./infrastructure/runtime/server-runtime-state.js";
import { configureRoomAuthentication } from "./shared/rooms/authenticated-room.js";
import { configureConnectionLimits } from "./shared/rooms/connection-limits.js";
import { createLogger } from "./shared/logger.js";
import { createColyseusLogger } from "./shared/log/colyseus-logger.js";
import { logSink } from "./shared/log/log-sink.js";

const logger = createLogger("Bootstrap");

export const container = createContainer({ database: db, redis, runtime: serverRuntimeState });
configureRoomAuthentication(container.authenticator, { ipLimiter: container.limiters.ip, joinLimiter: container.limiters.join });
configureConnectionLimits({ maxPerUser: container.config.maxConnectionsPerUser, maxPerRoomType: container.config.maxConnectionsPerUserPerRoom });

// Matchmaking HTTP: CORS only for the configured origins (WebGL builds; native clients need none), valid status codes for
// every matchmaking error, and a request size guard in front of Colyseus' own listener (see app/http.ts).
configureMatchmakingCors(container.config.corsOrigins);
guardMatchmakeErrorCodes();

const { rooms } = container;

const transport = new WebSocketTransport({ maxPayload: container.config.wsMaxPayloadBytes });
if (transport.server) {
  installRequestGuard(transport.server, {
    maxBodyBytes: container.config.httpMaxBodyBytes,
    // The Unity export bundle (zip) is the only large upload; the config router bounds it again while streaming.
    largerLimits: [{ prefix: "/admin/config/import", maxBytes: 60 * 1024 * 1024 }],
    headersTimeoutMs: 20_000,
    requestTimeoutMs: 120_000,
  });
}

export const server = defineServer({
  // Colyseus' own messages ("# SERVER_ERROR: ...", matchmaking and room errors) go to the log sink / GM panel.
  logger: createColyseusLogger(),
  // The ASCII banner is terminal noise; the one boot line comes from bootstrap/logging.ts.
  greet: container.config.logConsole === "all",
  transport,

  rooms: {
    auth: defineRoom(rooms.auth),
    economy: defineRoom(rooms.economy),
    profile: defineRoom(rooms.profile),
    account: defineRoom(rooms.account),
    roster: defineRoom(rooms.roster),
    rune: defineRoom(rooms.rune),
    summon: defineRoom(rooms.summon),
    presence: defineRoom(rooms.presence),
    chat_directory: defineRoom(rooms.chatDirectory),
    chat: defineRoom(rooms.chat).filterBy(["channel", "listOnly"]),
    guild_chat: defineRoom(rooms.guildChat),
    map: defineRoom(rooms.map),
    home: defineRoom(rooms.home),
    awaken: defineRoom(rooms.awaken),
    battle_pve: defineRoom(rooms.battlePve),
    shop: defineRoom(rooms.shop),
    arena: defineRoom(rooms.arena),
    guild: defineRoom(rooms.guild),
    mail: defineRoom(rooms.mail),
    story: defineRoom(rooms.story),
    missions: defineRoom(rooms.missions),
    ranking: defineRoom(rooms.ranking),
    social: defineRoom(rooms.social),
    battle_pvp: defineRoom(rooms.battlePvp),
  },

  express: (app) => configureHttp(app, container),

  beforeListen: async () => {
    // Persist the server logs (GM panel Logs) now that the schema is migrated; what was logged earlier is written first.
    logSink.attachStore(container.logStore);
    await container.services.catalogs.bootstrapOnStart();

    try {
      await redis.connect();
      logger.info("Redis ready");
    } catch (error) {
      logger.warn("Redis connect failed (sessions/caches unavailable):", (error as Error).message);
    }

    container.jobs.retention.schedule();
    container.jobs.accountPurge.schedule();
    container.jobs.arenaSeasonSweep.schedule();
    // Also once at boot, so a server that was down at the scheduled hour doesn't skip a day.
    void container.jobs.accountPurge.runSafely();
    void container.jobs.arenaSeasonSweep.runSafely();
  },
});

export default server;
