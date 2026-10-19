import { z } from "zod";
import { id, strictPayload } from "../../shared/validation.js";
import { GUILD_JOIN_TYPES } from "./guild.domain.js";

// Coarse caps only: the exact limits come from guild.json and are enforced by the service.
const name = z.string().max(64);
const text = z.string().max(1024);
const iconId = z.string().max(64);
const tags = z.array(z.string().max(64)).max(16);
const joinType = z.enum(GUILD_JOIN_TYPES);
const minLevel = z.coerce.number().int().min(1).max(999);
const guildId = id(36);
const handle = id(16);

export const GuildStateSchema = strictPayload({});
export const GuildRequestsSchema = strictPayload({});
export const GuildLeaveSchema = strictPayload({});

export const GuildListSchema = strictPayload({ query: z.string().max(64).optional().default("") });
export const GuildDetailsSchema = strictPayload({ guildId });
export const GuildCheckNameSchema = strictPayload({ name });

export const GuildCreateSchema = strictPayload({
  name,
  description: text.optional().default(""),
  iconId,
  tags: tags.optional().default([]),
  joinType: joinType.optional().default("open"),
  minLevel: minLevel.optional().default(1),
});

export const GuildJoinSchema = strictPayload({ guildId });
export const GuildCancelRequestSchema = strictPayload({ guildId });
export const GuildRequestDecisionSchema = strictPayload({ requestId: handle });
export const GuildMemberTargetSchema = strictPayload({ memberId: handle });
export const GuildSetRoleSchema = strictPayload({ memberId: handle, role: z.enum(["officer", "member"]) });

export const GuildUpdateSchema = strictPayload({
  description: text.optional(),
  notice: text.optional(),
  iconId: iconId.optional(),
  tags: tags.optional(),
  joinType: joinType.optional(),
  minLevel: minLevel.optional(),
});

export const GuildQuestsSchema = strictPayload({});
export const GuildClaimQuestSchema = strictPayload({ questId: id(64) });
export const GuildClaimChestSchema = strictPayload({ chestId: id(64) });
