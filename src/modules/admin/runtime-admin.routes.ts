import express from "express";
import { z } from "zod";
import { requireAdminKey } from "./admin-auth.js";
import type { ServerRuntimeState } from "../../infrastructure/runtime/server-runtime-state.js";
import type { RuntimeGrantsService } from "./runtime-grants.service.js";
import { ShopPackPayloadSchema } from "../../config/ShopCatalog.js";
import type { MailService } from "../mail/mail.service.js";
import { createLogger } from "../../shared/logger.js";
import { sendAdminError } from "./admin-http.js";
import { registerOpsRoutes } from "./runtime-admin-ops.routes.js";
import type { AdminAnalyticsService } from "./admin-analytics.service.js";
import type { AdminConfigService } from "./admin-config.service.js";
import type { AdminGuildsService } from "./admin-guilds.service.js";
import type { AdminLogsService } from "./admin-logs.service.js";
import type { AdminModerationService } from "./admin-moderation.service.js";
import type { AdminReportsService } from "./admin-reports.service.js";
import type { AdminPlayerEditsService } from "./admin-player-edits.service.js";
import type { AuditLog } from "../../shared/kernel/audit.js";
import { getCharacterCatalog } from "../../config/CharacterCatalog.js";
import { getCurrencyCatalog } from "../../config/CurrencyCatalog.js";
import { getRuneCatalog } from "../../config/RuneCatalog.js";
import { getStoryCatalog } from "../../config/StoryCatalog.js";
import type { AdminPlayersService } from "./admin-players.service.js";

const logger = createLogger("RuntimeAdmin");

const MaintenanceMutationSchema = z.object({
  enabled: z.boolean(),
  message: z.string().max(200).optional(),
  disconnectPlayers: z.boolean().optional(),
  closeCode: z.number().int().min(4000).max(4999).optional(),
  reason: z.string().max(200).optional(),
});

const DisconnectAllSchema = z.object({
  closeCode: z.number().int().min(4000).max(4999).optional(),
  reason: z.string().max(200).optional(),
});

const BroadcastNoticeSchema = z.object({
  kind: z.string().max(32).optional(),
  title: z.string().max(80).optional(),
  message: z.string().min(1).max(280),
  dismissSeconds: z.number().int().min(0).max(120).optional(),
});

const SearchPlayersSchema = z.object({
  q: z.string().min(1).max(120),
  limit: z.coerce.number().int().min(1).max(20).optional(),
});

const GrantCurrencySchema = z.object({
  target: z.string().min(1).max(120),
  currencyId: z.string().min(1).max(64),
  amount: z.number().int().min(1).max(1_000_000_000),
  reason: z.string().max(160).optional(),
});

const GrantCharacterSchema = z.object({
  target: z.string().min(1).max(120),
  characterId: z.string().min(1).max(120),
  targetLocation: z.enum(["BAG", "STORAGE"]).optional(),
  copies: z.number().int().min(1).max(100).optional(),
  stars: z.number().int().min(1).max(6).optional(),
  level: z.number().int().min(1).max(99).optional(),
  currentExp: z.number().int().min(0).max(10_000_000).optional(),
  awakeningIndex: z.number().int().min(0).max(12).optional(),
  reason: z.string().max(160).optional(),
});

const GrantRuneSchema = z.object({
  target: z.string().min(1).max(120),
  setId: z.string().min(1).max(64),
  slot: z.number().int().min(1).max(6),
  tier: z.number().int().min(1).max(6),
  variant: z.string().min(1).max(32),
  quality: z.number().int().min(1).max(5),
  copies: z.number().int().min(1).max(100).optional(),
  level: z.number().int().min(0).max(15).optional(),
  mainStatType: z.string().max(64).optional(),
  origin: z.string().max(64).optional(),
  reason: z.string().max(160).optional(),
});

/** GM mail: to one player (`target`) or to everyone (`broadcast`). Rewards use the shop payload shape. */
const SendMailSchema = z.object({
  target: z.string().min(1).max(120).optional(),
  broadcast: z.boolean().optional(),
  /** Broadcast only: accounts created later receive it too (until it expires). */
  includeNewPlayers: z.boolean().optional(),
  sender: z.string().max(32).optional(),
  title: z.string().min(1).max(80),
  body: z.string().max(1000).optional(),
  /** 0 = never expires; default from mail.json. */
  expirationDays: z.number().int().min(0).max(3650).optional(),
  attachments: ShopPackPayloadSchema.optional(),
  reason: z.string().max(160).optional(),
}).refine((value) => !!value.target !== !!value.broadcast, { message: "Set either target or broadcast." });

const PlayerParamSchema = z.object({ player: z.string().min(1).max(120) });

const AuditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  before: z.coerce.number().int().min(1).optional(),
});

/** Optional end date (ISO); omitted/null = permanent. */
const SanctionSchema = z.object({
  until: z.string().datetime({ offset: true }).nullish(),
  reason: z.string().max(255).optional(),
}).strict();

const KickSchema = z.object({ reason: z.string().max(255).optional() }).strict();

const SetCurrencySchema = z.object({
  currencyId: z.string().min(1).max(64),
  amount: z.number().int().min(0).max(2_000_000_000),
  reason: z.string().max(160).optional(),
}).strict();

const SetLevelSchema = z.object({
  level: z.number().int().min(1).max(999),
  reason: z.string().max(160).optional(),
}).strict();

const ResetStorySchema = z.object({
  scope: z.union([z.enum(["all", "tutorial", "story"]), z.array(z.string().min(1).max(64)).min(1).max(100)]),
}).strict();

export type RuntimeAdminDeps = {
  apiKey: string;
  runtime: ServerRuntimeState;
  grants: RuntimeGrantsService;
  mail: MailService;
  audit: AuditLog;
  players: AdminPlayersService;
  edits: AdminPlayerEditsService;
  analytics: AdminAnalyticsService;
  guilds: AdminGuildsService;
  moderation: AdminModerationService;
  config: AdminConfigService;
  reports: AdminReportsService;
  logs: AdminLogsService;
};

/** `/admin/runtime/*` — GM panel API (header `x-config-api-key`). */
export function createRuntimeAdminRouter(deps: RuntimeAdminDeps) {
  const { apiKey, runtime: serverRuntimeState, grants: grantsService, mail: mailService, audit, players, edits, analytics, guilds, moderation, config, reports, logs } = deps;
  const router = express.Router();
  router.use(requireAdminKey(apiKey));

  // Every state-changing admin call is recorded in the audit trail.
  router.use((req, _res, next) => {
    if (req.method === "POST") {
      // Player routes carry the id in the path: keep it out of the kind (the service audits on the player's trail).
      const action = req.path
        .replace(/^\/players\/[^/]+/, "/player")
        .replace(/\/(units|runes)\/[^/]+/, "/$1")
        .replace(/^\/(guilds|mail\/broadcasts|reports)\/(?!target\/)[^/]+/, "/$1")
        .replace(/^\/reports\/target\/[^/]+/, "/reports/target");
      audit.record({ userId: null, kind: `ADMIN${action.replace(/[^a-z]+/gi, "_").toUpperCase()}`.slice(0, 32), meta: { path: req.path, ip: req.ip ?? null } })
        .catch((error) => logger.warn("audit failed:", (error as Error).message));
    }
    next();
  });

  router.get("/status", async (_req, res) => {
    // `reports.open` feeds the sidebar badge of the Reports view (null when the count could not be read).
    const open = await reports.openCount().catch((): null => null);
    res.json({
      ok: true,
      snapshot: await serverRuntimeState.getDashboardSnapshot(),
      reports: { open },
    });
  });

  router.get("/players/search", async (req, res) => {
    try {
      const payload = SearchPlayersSchema.parse(req.query ?? {});
      const results = await grantsService.searchTargets(payload.q, payload.limit);
      res.json({
        ok: true,
        results,
      });
    } catch (error) {
      sendAdminError(res, error);
    }
  });

  // ── Catalog summary (panel pickers) ────────────────────────────────
  router.get("/catalog/summary", (_req, res) => {
    res.json({
      ok: true,
      currencies: getCurrencyCatalog().currencies.map((c) => ({ id: c.id, hasCap: c.hasCap, rechargeable: c.rechargeable })),
      characters: getCharacterCatalog().characters.map((c) => ({ id: c.id, element: c.element, naturalStars: c.naturalStars })),
      runeSets: getRuneCatalog().sets.map((set) => ({ id: set.id, name: set.displayName ?? set.id })),
      dialogues: getStoryCatalog().dialogues.map((d) => d.id),
    });
  });

  // ── Players (detail, moderation, edits) ────────────────────────────
  const playerRoute = (handler: (player: string, req: express.Request) => Promise<object>) =>
    async (req: express.Request, res: express.Response) => {
      try {
        const { player } = PlayerParamSchema.parse(req.params);
        res.json({ ok: true, ...(await handler(player, req)) });
      } catch (error) {
        sendAdminError(res, error);
      }
    };
  const dateOrNull = (value: string | null | undefined) => (value ? new Date(value) : null);

  router.get("/players/:player", playerRoute(async (player) => ({ player: await players.getDetail(player) })));
  router.get("/players/:player/audit", playerRoute(async (player, req) => {
    const query = AuditQuerySchema.parse(req.query ?? {});
    return { entries: await players.auditTrail(player, query.limit ?? 50, query.before) };
  }));
  router.post("/players/:player/kick", playerRoute(async (player, req) => players.kick(player, KickSchema.parse(req.body ?? {}).reason)));
  router.post("/players/:player/ban", playerRoute(async (player, req) => {
    const body = SanctionSchema.parse(req.body ?? {});
    return players.ban(player, dateOrNull(body.until), body.reason);
  }));
  router.post("/players/:player/unban", playerRoute(async (player) => players.unban(player)));
  router.post("/players/:player/mute", playerRoute(async (player, req) => {
    const body = SanctionSchema.parse(req.body ?? {});
    return players.mute(player, dateOrNull(body.until), body.reason);
  }));
  router.post("/players/:player/unmute", playerRoute(async (player) => players.unmute(player)));
  router.post("/players/:player/currency", playerRoute(async (player, req) => {
    const body = SetCurrencySchema.parse(req.body ?? {});
    return players.setCurrency(player, body.currencyId, body.amount, body.reason);
  }));
  router.post("/players/:player/level", playerRoute(async (player, req) => {
    const body = SetLevelSchema.parse(req.body ?? {});
    return players.setLevel(player, body.level, body.reason);
  }));
  router.post("/players/:player/story/reset", playerRoute(async (player, req) => players.resetStory(player, ResetStorySchema.parse(req.body ?? {}).scope)));

  router.post("/maintenance", async (req, res) => {
    try {
      const payload = MaintenanceMutationSchema.parse(req.body ?? {});
      const result = await serverRuntimeState.setMaintenance(payload);
      res.json({ ok: true, ...result });
    } catch (error) {
      sendAdminError(res, error);
    }
  });

  router.post("/disconnect-all", async (req, res) => {
    try {
      const payload = DisconnectAllSchema.parse(req.body ?? {});
      const disconnect = await serverRuntimeState.disconnectAllPlayers(
        payload.closeCode,
        payload.reason
      );

      res.json({
        ok: true,
        disconnect,
        snapshot: await serverRuntimeState.getDashboardSnapshot(),
      });
    } catch (error) {
      sendAdminError(res, error);
    }
  });

  router.post("/broadcast-notice", async (req, res) => {
    try {
      const payload = BroadcastNoticeSchema.parse(req.body ?? {});
      const result = await serverRuntimeState.broadcastNotice(payload);
      res.json({ ok: true, ...result });
    } catch (error) {
      sendAdminError(res, error);
    }
  });

  router.post("/grant/currency", async (req, res) => {
    try {
      const payload = GrantCurrencySchema.parse(req.body ?? {});
      const result = await grantsService.grantCurrency(payload);
      res.json({ ok: true, ...result });
    } catch (error) {
      sendAdminError(res, error);
    }
  });

  router.post("/grant/character", async (req, res) => {
    try {
      const payload = GrantCharacterSchema.parse(req.body ?? {});
      const result = await grantsService.grantCharacter(payload);
      res.json({ ok: true, ...result });
    } catch (error) {
      sendAdminError(res, error);
    }
  });

  router.post("/grant/rune", async (req, res) => {
    try {
      const payload = GrantRuneSchema.parse(req.body ?? {});
      const result = await grantsService.grantRune(payload);
      res.json({ ok: true, ...result });
    } catch (error) {
      sendAdminError(res, error);
    }
  });

  router.post("/mail/send", async (req, res) => {
    try {
      const payload = SendMailSchema.parse(req.body ?? {});
      mailService.validateAttachments(payload.attachments);
      const draft = {
        category: "gm" as const,
        sender: payload.sender ?? "",
        title: payload.title,
        body: payload.body ?? "",
        attachments: payload.attachments ?? null,
        ...(payload.expirationDays !== undefined ? { expirationDays: payload.expirationDays } : {}),
      };

      if (payload.broadcast) {
        const result = await mailService.broadcast(draft, payload.includeNewPlayers ?? false);
        res.json({ ok: true, broadcast: true, ...result });
        return;
      }

      const target = await grantsService.findTarget(payload.target!);
      await edits.sendMail(target.userId, draft, payload.reason);
      res.json({ ok: true, target });
    } catch (error) {
      sendAdminError(res, error);
    }
  });

  registerOpsRoutes(router, { analytics, players, edits, guilds, moderation, config, reports, logs });

  return router;
}
