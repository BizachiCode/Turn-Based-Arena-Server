// GM panel "Players": edits of what a player owns or is called — nickname, mail, units, runes, guild membership.
// Every action is audited on the player's trail; the writes that touch several rows run in one transaction and
// reuse the roster / rune / guild repositories so the invariants (equipped runes, capacities) stay in one place.

import type { MailDraft } from "../mail/mail.service.js";
import type { AuditLog } from "../../shared/kernel/audit.js";
import type { UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import type { MonsterProgression } from "../progression/progression.rules.js";
import type { CharacterRepository, ReservedUnits } from "../roster/roster.ports.js";
import type { RuneRepository } from "../rune/rune.ports.js";
import type { AdminUserDirectory, AdminUserRef } from "./admin.ports.js";
import { AdminPlayerError } from "./admin-players.service.js";

/** Nickname rules of the player-facing rename (`ProfileService`). */
export interface AdminNicknames {
  getProfile(userId: string): Promise<{ name: string } | null>;
  changeNickname(userId: string, nickname: string, options?: { operator?: boolean }): Promise<{ nickname: string }>;
}

/** Mailbox of the GM tools (`MailService`). */
export interface AdminMailSender {
  validateAttachments(attachments: MailDraft["attachments"] | undefined): void;
  send(userId: string, draft: MailDraft): Promise<boolean>;
}

/** Guild membership removal (`GuildService.operatorRemoveMember`). */
export interface AdminGuildMembership {
  operatorRemoveMember(userId: string): Promise<{ guildId: string; disbanded: boolean }>;
}

export type AdminPlayerEditsDeps = {
  users: AdminUserDirectory;
  nicknames: AdminNicknames;
  mail: AdminMailSender;
  guilds: AdminGuildMembership;
  characters: CharacterRepository;
  runes: RuneRepository;
  progression: Pick<MonsterProgression, "maxLevelForStars">;
  /** Units kept in a team setup (arena defense) cannot be deleted. */
  reserved?: ReservedUnits;
  /** Drop the read-through caches of the roster / rune lists. */
  invalidateRoster: (userId: string) => Promise<void>;
  invalidateRunes: (userId: string) => Promise<void>;
  audit: AuditLog;
  uow: UnitOfWork;
};

const MAX_STARS = 6;

export class AdminPlayerEditsService {
  constructor(private readonly deps: AdminPlayerEditsDeps) {}

  /** Same validation and uniqueness as the client rename (`profile/change_nickname`). */
  async rename(selector: string, nickname: string, reason?: string): Promise<{ userId: string; from: string | null; nickname: string }> {
    const target = await this.resolve(selector);
    const from = (await this.deps.nicknames.getProfile(target.userId))?.name ?? null;
    const result = await this.deps.nicknames.changeNickname(target.userId, nickname, { operator: true });
    await this.deps.audit.record({ userId: target.userId, kind: "GM_RENAME", meta: { from, to: result.nickname, reason: normalize(reason) } });
    return { userId: target.userId, from, nickname: result.nickname };
  }

  /** One GM mail to this player (rewards use the shop payload shape, validated against the catalogs). */
  async sendMail(selector: string, draft: MailDraft, reason?: string): Promise<{ userId: string }> {
    const target = await this.resolve(selector);
    this.deps.mail.validateAttachments(draft.attachments);
    await this.deps.mail.send(target.userId, { ...draft, category: "gm" });
    await this.deps.audit.record({ userId: target.userId, kind: "GM_MAIL", meta: { title: draft.title ?? "", reason: normalize(reason) } });
    return { userId: target.userId };
  }

  /** Deletes a unit; the runes it wears go back to the rune inventory first. */
  async deleteUnit(selector: string, unitUid: string, reason?: string): Promise<{ userId: string; uid: string; unequipped: number }> {
    const target = await this.resolve(selector);
    const unequipped = await this.deps.uow.transaction(async (session) => {
      const [unit] = await this.deps.characters.lockByUids(target.userId, [unitUid], session);
      if (!unit) throw new AdminPlayerError("Unit not found.");
      if (this.deps.reserved && (await this.deps.reserved.reservedUids(target.userId, session)).has(unitUid)) {
        throw new AdminPlayerError("The unit is part of the arena defense team.");
      }
      const worn = await this.deps.runes.listEquippedOn(target.userId, [unitUid], session);
      for (const rune of worn) await this.deps.runes.setEquipped(target.userId, rune.uid, null, session);
      if ((await this.deps.characters.deleteCharacters(target.userId, [unitUid], session)) !== 1) throw new AdminPlayerError("Unit not found.");
      await this.deps.audit.record({
        userId: target.userId,
        kind: "GM_DELETE_UNIT",
        meta: { uid: unitUid, characterId: unit.characterId, stars: unit.stars, level: unit.level, unequipped: worn.length, reason: normalize(reason) },
      }, session);
      return worn.length;
    });
    await this.deps.invalidateRoster(target.userId);
    if (unequipped > 0) await this.deps.invalidateRunes(target.userId);
    return { userId: target.userId, uid: unitUid, unequipped };
  }

  /**
   * Sets stars and/or level. A star change resets the level (and EXP) like an evolve; the level must fit the star
   * tier of `config.json > gameplay`. Awakening and skill levels are untouched.
   */
  async setUnit(selector: string, unitUid: string, edit: { level?: number; stars?: number }, reason?: string):
    Promise<{ userId: string; uid: string; stars: number; level: number }> {
    const target = await this.resolve(selector);
    if (edit.level === undefined && edit.stars === undefined) throw new AdminPlayerError("Nothing to change.");
    const result = await this.deps.uow.transaction(async (session) => {
      const [unit] = await this.deps.characters.lockByUids(target.userId, [unitUid], session);
      if (!unit) throw new AdminPlayerError("Unit not found.");

      const stars = edit.stars ?? unit.stars;
      if (!Number.isInteger(stars) || stars < 1 || stars > MAX_STARS) throw new AdminPlayerError(`Stars must be between 1 and ${MAX_STARS}.`);
      const maxLevel = this.deps.progression.maxLevelForStars(stars);
      const level = edit.level ?? (edit.stars !== undefined ? 1 : unit.level);
      if (!Number.isInteger(level) || level < 1 || level > maxLevel) throw new AdminPlayerError(`Level must be between 1 and ${maxLevel} for ${stars} stars.`);

      if (stars !== unit.stars) await this.deps.characters.updateStars(target.userId, unitUid, stars, session);
      await this.deps.characters.updateProgress(target.userId, unitUid, level, 0, session);
      await this.deps.audit.record({
        userId: target.userId,
        kind: "GM_SET_UNIT",
        meta: { uid: unitUid, characterId: unit.characterId, from: { stars: unit.stars, level: unit.level }, to: { stars, level }, reason: normalize(reason) },
      }, session);
      return { stars, level };
    });
    await this.deps.invalidateRoster(target.userId);
    return { userId: target.userId, uid: unitUid, ...result };
  }

  /** Deletes a rune without refund (taken off its unit first, locked or not). */
  async deleteRune(selector: string, runeUid: string, reason?: string): Promise<{ userId: string; uid: string }> {
    const target = await this.resolve(selector);
    await this.deps.uow.transaction(async (session) => {
      const rune = await this.deps.runes.find(target.userId, runeUid, session, true);
      if (!rune) throw new AdminPlayerError("Rune not found.");
      if (rune.equippedToUid) await this.deps.runes.setEquipped(target.userId, runeUid, null, session);
      if ((await this.deps.runes.delete(target.userId, runeUid, session)) !== 1) throw new AdminPlayerError("Rune not found.");
      await this.deps.audit.record({
        userId: target.userId,
        kind: "GM_DELETE_RUNE",
        meta: { uid: runeUid, setId: rune.setId, slot: rune.slot, level: rune.level, quality: rune.quality, equippedTo: rune.equippedToUid, reason: normalize(reason) },
      }, session);
    });
    await this.deps.invalidateRunes(target.userId);
    return { userId: target.userId, uid: runeUid };
  }

  /** Takes the player out of their guild (a leader hands the lead to the oldest officer / member). */
  async removeFromGuild(selector: string, reason?: string): Promise<{ userId: string; guildId: string; disbanded: boolean }> {
    const target = await this.resolve(selector);
    let outcome: { guildId: string; disbanded: boolean };
    try {
      outcome = await this.deps.guilds.operatorRemoveMember(target.userId);
    } catch (error) {
      if ((error as { errorCode?: string }).errorCode === "GUILD_NOT_MEMBER") throw new AdminPlayerError("The player is not in a guild.");
      throw error;
    }
    await this.deps.audit.record({ userId: target.userId, kind: "GM_GUILD_REMOVE", meta: { ...outcome, reason: normalize(reason) } });
    return { userId: target.userId, ...outcome };
  }

  private async resolve(selector: string): Promise<AdminUserRef> {
    const value = String(selector || "").trim();
    if (!value) throw new AdminPlayerError("Player id, username or email is required.");
    const user = await this.deps.users.resolve(value);
    if (!user) throw new AdminPlayerError("Player not found.");
    return user;
  }
}

function normalize(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim().slice(0, 255) : "";
  return text.length > 0 ? text : null;
}
