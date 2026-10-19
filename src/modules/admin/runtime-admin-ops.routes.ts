// GM panel routes of the read-heavy views (overview, players list, guilds, chat, mail history, audit log, config)
// and the player edits. Mounted by `createRuntimeAdminRouter` behind the admin key; every payload is a strict schema.

import express from "express";
import { z } from "zod";
import { ShopPackPayloadSchema } from "../../config/ShopCatalog.js";
import { adminRoute } from "./admin-http.js";
import type { AdminAnalyticsService } from "./admin-analytics.service.js";
import type { AdminConfigService } from "./admin-config.service.js";
import { GUILD_FILTERS, GUILD_SORTS } from "./admin-guilds.ports.js";
import type { AdminGuildsService } from "./admin-guilds.service.js";
import type { AdminLogsService } from "./admin-logs.service.js";
import { LOG_LEVELS, type LogLevel } from "../../shared/log/log-types.js";
import type { AdminModerationService } from "./admin-moderation.service.js";
import type { AdminPlayerEditsService } from "./admin-player-edits.service.js";
import { PLAYER_FILTERS, PLAYER_SORTS } from "./admin-players.ports.js";
import type { AdminPlayersService } from "./admin-players.service.js";
import { REPORT_SORTS, REPORT_TABS } from "./admin-reports.ports.js";
import type { AdminReportsService } from "./admin-reports.service.js";

export type RuntimeAdminOpsDeps = {
  reports: AdminReportsService;
  analytics: AdminAnalyticsService;
  players: AdminPlayersService;
  edits: AdminPlayerEditsService;
  guilds: AdminGuildsService;
  moderation: AdminModerationService;
  config: AdminConfigService;
  logs: AdminLogsService;
};

const Reason = z.string().max(160).optional();
const Page = { page: z.coerce.number().int().min(1).max(100_000).optional(), pageSize: z.coerce.number().int().min(1).max(100).optional() };
const Direction = z.enum(["asc", "desc"]).optional();
const Search = z.string().max(120).optional();

const AnalyticsQuerySchema = z.object({ days: z.coerce.number().int().refine((value) => [7, 14, 30].includes(value), "days must be 7, 14 or 30").optional() }).strict();

const PlayersQuerySchema = z.object({
  filter: z.enum(PLAYER_FILTERS).optional(),
  q: Search,
  sort: z.enum(PLAYER_SORTS).optional(),
  dir: Direction,
  ...Page,
}).strict();

const GuildsQuerySchema = z.object({
  filter: z.enum(GUILD_FILTERS).optional(),
  q: Search,
  sort: z.enum(GUILD_SORTS).optional(),
  dir: Direction,
  ...Page,
}).strict();

const RenameSchema = z.object({ nickname: z.string().min(1).max(64), reason: Reason }).strict();

const PlayerMailSchema = z.object({
  sender: z.string().max(32).optional(),
  title: z.string().min(1).max(80),
  body: z.string().max(1000).optional(),
  expirationDays: z.number().int().min(0).max(3650).optional(),
  attachments: ShopPackPayloadSchema.optional(),
  reason: Reason,
}).strict();

const UnitEditSchema = z.object({
  level: z.number().int().min(1).max(999).optional(),
  stars: z.number().int().min(1).max(6).optional(),
  reason: Reason,
}).strict();

const ReasonOnlySchema = z.object({ reason: Reason }).strict();

const GuildIdSchema = z.object({ guildId: z.string().min(1).max(36) });
const MemberSchema = z.object({ memberId: z.string().min(1).max(32), reason: Reason }).strict();
const GuildUpdateSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  description: z.string().max(255).optional(),
  notice: z.string().max(255).optional(),
  reason: Reason,
}).strict();

const ChatQuerySchema = z.object({
  scope: z.enum(["global", "guild"]),
  channel: z.coerce.number().int().min(0).max(100_000).optional(),
  guildId: z.string().min(1).max(36).optional(),
  userId: z.string().min(1).max(36).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  before: z.coerce.number().int().min(1).optional(),
}).strict();

const ChatDeleteSchema = z.object({
  scope: z.enum(["global", "guild"]),
  id: z.number().int().min(1),
  reason: Reason,
}).strict();

const MailHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  before: z.coerce.number().int().min(1).optional(),
}).strict();

const BroadcastIdSchema = z.object({ id: z.string().min(1).max(16) });

const AuditQuerySchema = z.object({
  kind: z.string().min(1).max(32).optional(),
  userId: z.string().min(1).max(36).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  before: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
}).strict();

/** `levels=warn,error` (a subset of debug / info / warn / error). */
const LogLevelsParam = z.string().max(40).transform((value, ctx) => {
  const levels = value.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
  const invalid = levels.find((level) => !(LOG_LEVELS as readonly string[]).includes(level));
  if (invalid) {
    ctx.addIssue({ code: "custom", message: `unknown level ${invalid}` });
    return z.NEVER;
  }
  return [...new Set(levels)] as LogLevel[];
});

const LogsQuerySchema = z.object({
  levels: LogLevelsParam.optional(),
  scope: z.string().min(1).max(48).optional(),
  q: z.string().max(120).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  before: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
}).strict();

const ChatFilterTestSchema = z.object({ text: z.string().min(1).max(500) }).strict();

const ReportsQuerySchema = z.object({
  tab: z.enum(REPORT_TABS).optional(),
  q: Search,
  sort: z.enum(REPORT_SORTS).optional(),
  dir: Direction,
  target: z.string().min(1).max(36).optional(),
  reporter: z.string().min(1).max(36).optional(),
  ...Page,
}).strict();

const ReportIdParam = z.object({ id: z.coerce.number().int().min(1) });

const ReportResolveSchema = z.object({
  action: z.enum(["none", "warn", "mute", "kick", "ban"]).optional(),
  muteHours: z.number().int().min(1).max(8760).optional(),
  /** Absent / null = permanent ban. */
  banDays: z.number().int().min(1).max(3650).nullable().optional(),
  message: z.string().max(255).optional(),
  note: z.string().max(255).optional(),
}).strict();

const ReportDismissSchema = z.object({ note: z.string().max(255).optional() }).strict();

const PlayerParam = z.object({ player: z.string().min(1).max(120) });
const UidParam = z.object({ player: z.string().min(1).max(120), uid: z.string().min(1).max(64) });

/** Registers the routes on `router` (already behind the admin key and the POST audit middleware). */
export function registerOpsRoutes(router: express.Router, deps: RuntimeAdminOpsDeps): void {
  const { analytics, players, edits, guilds, moderation, config, reports, logs } = deps;

  // ── Overview ───────────────────────────────────────────────────────
  router.get("/analytics", adminRoute(async (req) => ({
    analytics: await analytics.overview(AnalyticsQuerySchema.parse(req.query ?? {}).days ?? 7),
  })));

  // ── Players list and edits ─────────────────────────────────────────
  router.get("/players", adminRoute(async (req) => players.list(PlayersQuerySchema.parse(req.query ?? {}))));
  router.post("/players/:player/rename", adminRoute(async (req) => {
    const { player } = PlayerParam.parse(req.params);
    const body = RenameSchema.parse(req.body ?? {});
    return edits.rename(player, body.nickname, body.reason);
  }));
  router.post("/players/:player/mail", adminRoute(async (req) => {
    const { player } = PlayerParam.parse(req.params);
    const { reason, attachments, ...draft } = PlayerMailSchema.parse(req.body ?? {});
    return edits.sendMail(player, { ...draft, attachments: attachments ?? null }, reason);
  }));
  router.post("/players/:player/units/:uid/delete", adminRoute(async (req) => {
    const { player, uid } = UidParam.parse(req.params);
    return edits.deleteUnit(player, uid, ReasonOnlySchema.parse(req.body ?? {}).reason);
  }));
  router.post("/players/:player/units/:uid/set", adminRoute(async (req) => {
    const { player, uid } = UidParam.parse(req.params);
    const { reason, ...edit } = UnitEditSchema.parse(req.body ?? {});
    return edits.setUnit(player, uid, edit, reason);
  }));
  router.post("/players/:player/runes/:uid/delete", adminRoute(async (req) => {
    const { player, uid } = UidParam.parse(req.params);
    return edits.deleteRune(player, uid, ReasonOnlySchema.parse(req.body ?? {}).reason);
  }));
  router.post("/players/:player/guild/remove", adminRoute(async (req) => {
    const { player } = PlayerParam.parse(req.params);
    return edits.removeFromGuild(player, ReasonOnlySchema.parse(req.body ?? {}).reason);
  }));
  router.post("/players/:player/sessions/revoke", adminRoute(async (req) => {
    const { player } = PlayerParam.parse(req.params);
    return players.revokeSessions(player, ReasonOnlySchema.parse(req.body ?? {}).reason);
  }));

  // ── Guilds ─────────────────────────────────────────────────────────
  router.get("/guilds", adminRoute(async (req) => guilds.list(GuildsQuerySchema.parse(req.query ?? {}))));
  router.get("/guilds/:guildId", adminRoute(async (req) => ({ detail: await guilds.detail(GuildIdSchema.parse(req.params).guildId) })));
  router.post("/guilds/:guildId/kick", adminRoute(async (req) => {
    const body = MemberSchema.parse(req.body ?? {});
    return guilds.kick(GuildIdSchema.parse(req.params).guildId, body.memberId, body.reason);
  }));
  router.post("/guilds/:guildId/transfer", adminRoute(async (req) => {
    const body = MemberSchema.parse(req.body ?? {});
    return guilds.transfer(GuildIdSchema.parse(req.params).guildId, body.memberId, body.reason);
  }));
  router.post("/guilds/:guildId/disband", adminRoute(async (req) =>
    guilds.disband(GuildIdSchema.parse(req.params).guildId, ReasonOnlySchema.parse(req.body ?? {}).reason)));
  router.post("/guilds/:guildId/update", adminRoute(async (req) => {
    const { reason, ...input } = GuildUpdateSchema.parse(req.body ?? {});
    return { detail: await guilds.update(GuildIdSchema.parse(req.params).guildId, input, reason) };
  }));

  // ── Chat moderation ────────────────────────────────────────────────
  router.get("/chat/channels", adminRoute(async () => ({ channels: await moderation.chatChannels() })));
  router.get("/chat/messages", adminRoute(async (req) => moderation.chat(ChatQuerySchema.parse(req.query ?? {}))));
  router.post("/chat/messages/delete", adminRoute(async (req) => {
    const body = ChatDeleteSchema.parse(req.body ?? {});
    return moderation.deleteChatMessage(body.scope, body.id, body.reason);
  }));

  router.get("/chat/filter", adminRoute(async () => moderation.chatFilter()));
  router.get("/chat/filter/test", adminRoute(async (req) => moderation.chatFilterTest(ChatFilterTestSchema.parse(req.query ?? {}).text)));

  // ── Player reports ─────────────────────────────────────────────────
  router.get("/reports", adminRoute(async (req) => {
    const { target, reporter, ...query } = ReportsQuerySchema.parse(req.query ?? {});
    return reports.list({ ...query, targetUserId: target ?? null, reporterUserId: reporter ?? null });
  }));
  router.get("/reports/:id", adminRoute(async (req) => ({ detail: await reports.detail(ReportIdParam.parse(req.params).id) })));
  router.post("/reports/:id/resolve", adminRoute(async (req) => {
    const body = ReportResolveSchema.parse(req.body ?? {});
    return reports.resolve(ReportIdParam.parse(req.params).id, { ...body, action: body.action ?? "none" });
  }));
  router.post("/reports/:id/dismiss", adminRoute(async (req) =>
    reports.dismiss(ReportIdParam.parse(req.params).id, ReportDismissSchema.parse(req.body ?? {}).note)));
  router.post("/reports/target/:player/resolve", adminRoute(async (req) => {
    const { player } = PlayerParam.parse(req.params);
    const body = ReportResolveSchema.parse(req.body ?? {});
    return reports.resolveTarget(player, { ...body, action: body.action ?? "none" });
  }));
  router.post("/reports/target/:player/dismiss", adminRoute(async (req) => {
    const { player } = PlayerParam.parse(req.params);
    return reports.dismissTarget(player, ReportDismissSchema.parse(req.body ?? {}).note);
  }));

  // ── Mail history ───────────────────────────────────────────────────
  router.get("/mail/history", adminRoute(async (req) => {
    const query = MailHistoryQuerySchema.parse(req.query ?? {});
    return moderation.mailHistory(query.limit ?? 50, query.before ?? null);
  }));
  router.post("/mail/broadcasts/:id/revoke", adminRoute(async (req) =>
    moderation.revokeBroadcast(BroadcastIdSchema.parse(req.params).id, ReasonOnlySchema.parse(req.body ?? {}).reason)));

  // ── Audit log ──────────────────────────────────────────────────────
  router.get("/audit", adminRoute(async (req) => {
    const query = AuditQuerySchema.parse(req.query ?? {});
    return moderation.auditLog({
      kind: query.kind ?? null,
      userId: query.userId ?? null,
      from: query.from ? new Date(query.from) : null,
      to: query.to ? new Date(query.to) : null,
      before: query.before ?? null,
      limit: query.limit ?? 50,
    });
  }));
  router.get("/audit/kinds", adminRoute(async () => ({ kinds: await moderation.auditKinds() })));

  // ── Server logs ────────────────────────────────────────────────────
  router.get("/logs", adminRoute(async (req) => {
    const query = LogsQuerySchema.parse(req.query ?? {});
    return logs.list({
      levels: query.levels ?? [],
      scope: query.scope ?? null,
      q: query.q ?? null,
      from: query.from ? new Date(query.from) : null,
      to: query.to ? new Date(query.to) : null,
      before: query.before ?? null,
      limit: query.limit ?? 100,
    });
  }));
  router.get("/logs/summary", adminRoute(async () => ({ summary: await logs.summary() })));

  // ── Config (read only) ─────────────────────────────────────────────
  router.get("/config/files", adminRoute(async () => ({ files: await config.files() })));
}
