// GM grants (admin HTTP API only): currencies, characters and runes pushed live to the player.

import type { AuditLog } from "../../shared/kernel/audit.js";
import type { UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import type { WalletLedger } from "../economy/wallet-ledger.js";
import type { CurrencyRules } from "../economy/economy.ports.js";
import type { EconomyService } from "../economy/economy.service.js";
import type { CharacterGrantService } from "../roster/character-grant.service.js";
import type { RosterCache } from "../roster/roster.cache.js";
import type { RuneService } from "../rune/rune.service.js";
import type { RuneCache } from "../rune/rune.cache.js";
import type { RuneRules } from "../rune/rune.ports.js";
import type { RuntimeGrantedCharacter, RuntimeGrantedRune, RuntimePlayerGrantPayload } from "../../infrastructure/runtime/server-runtime-state.js";
import type { AdminUserDirectory, AdminUserRef } from "./admin.ports.js";

type GrantLocation = "BAG" | "STORAGE";

export type GrantCurrencyInput = { target: string; currencyId: string; amount: number; reason?: string };

export type GrantCharacterInput = {
  target: string;
  characterId: string;
  targetLocation?: GrantLocation;
  copies?: number;
  stars?: number;
  level?: number;
  currentExp?: number;
  awakeningIndex?: number;
  reason?: string;
};

export type GrantRuneInput = {
  target: string;
  setId: string;
  slot: number;
  tier: number;
  variant: string;
  quality: number;
  copies?: number;
  level?: number;
  mainStatType?: string;
  origin?: string;
  reason?: string;
};

/** Pushes a grant to the player's live presence connections (optional). */
export interface GrantNotifier {
  pushPlayerGrant(
    userId: string,
    payload: RuntimePlayerGrantPayload,
    detail?: { targetLabel?: string | null; currencyId?: string | null; currencyAmount?: number | null },
  ): Promise<{ deliveryCount: number; snapshot: unknown }>;
}

export class RuntimeGrantsService {
  constructor(
    private readonly users: AdminUserDirectory,
    private readonly economy: EconomyService,
    private readonly ledger: WalletLedger,
    private readonly currencies: CurrencyRules,
    private readonly characterGrants: CharacterGrantService,
    private readonly rosterCache: RosterCache,
    private readonly runes: RuneService,
    private readonly runeRules: RuneRules,
    private readonly runeCache: RuneCache,
    private readonly notifier: GrantNotifier,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  async grantCurrency(input: GrantCurrencyInput) {
    const target = await this.resolveTarget(input.target);
    const currencyId = String(input.currencyId || "").trim();
    const amount = Math.max(1, Math.floor(Number(input.amount) || 0));
    if (!this.currencies.get(currencyId)) throw new Error(`Unknown currency: ${currencyId}`);

    await this.economy.ensureUserCurrencies(target.userId);
    await this.uow.transaction(async (session) => {
      await this.ledger.credit(session, target.userId, [{ currencyId, amount }]);
      await this.audit.record({ userId: target.userId, kind: "GM_GRANT_CURRENCY", meta: { currencyId, amount, reason: input.reason ?? null } }, session);
    });
    const wallet = await this.ledger.snapshot(target.userId);

    const runtime = await this.notifier.pushPlayerGrant(
      target.userId,
      { grantedAt: new Date().toISOString(), reason: normalizeReason(input.reason), wallet },
      { targetLabel: target.username, currencyId, currencyAmount: amount },
    );

    return { target, deliveryCount: runtime.deliveryCount, snapshot: runtime.snapshot, wallet };
  }

  async grantCharacter(input: GrantCharacterInput) {
    const target = await this.resolveTarget(input.target);
    const location: GrantLocation = String(input.targetLocation || "BAG").toUpperCase() === "STORAGE" ? "STORAGE" : "BAG";
    const copies = normalizeCopies(input.copies);

    const records = await this.uow.transaction(async (session) => {
      await this.audit.record({ userId: target.userId, kind: "GM_GRANT_CHARACTER", meta: { characterId: input.characterId, copies, reason: input.reason ?? null } }, session);
      return this.characterGrants.grant(
      session,
      target.userId,
      Array.from({ length: copies }, () => ({
        characterId: String(input.characterId || "").trim(),
        stars: input.stars,
        level: input.level,
        currentExp: input.currentExp,
        awakeningIndex: input.awakeningIndex,
      })),
      location,
      location === "STORAGE" ? "STORAGE_FULL" : "BAG_FULL",
      );
    });
    await this.rosterCache.invalidate(target.userId);

    const characters: RuntimeGrantedCharacter[] = records.map((record) => ({
      uid: record.uid,
      characterId: record.characterId,
      stars: record.stars,
      level: record.level,
      currentExp: record.currentExp,
      awakened: record.awakeningIndex > 0,
      skillLevels: record.skillLevels,
      awakeningIndex: record.awakeningIndex,
      location,
    }));

    const runtime = await this.notifier.pushPlayerGrant(
      target.userId,
      { grantedAt: new Date().toISOString(), reason: normalizeReason(input.reason), characters },
      { targetLabel: target.username },
    );

    return { target, deliveryCount: runtime.deliveryCount, snapshot: runtime.snapshot, characters, character: characters[0] ?? null };
  }

  async grantRune(input: GrantRuneInput) {
    const target = await this.resolveTarget(input.target);
    const setId = String(input.setId || "").trim();
    if (!this.runeRules.catalog().sets.some((set) => String(set.id) === setId)) throw new Error(`Unknown rune set: ${setId}`);

    const copies = normalizeCopies(input.copies);
    const spec = {
      setId,
      slot: Number(input.slot) | 0,
      tier: Number(input.tier) | 0,
      variant: String(input.variant || "Normal").trim() || "Normal",
      quality: Number(input.quality) | 0,
      level: Number(input.level ?? 0) | 0,
      mainStatType: input.mainStatType ? String(input.mainStatType) : undefined,
      origin: input.origin ? String(input.origin) : "gm_panel",
    };

    const runes = await this.uow.transaction(async (session) => {
      await this.audit.record({ userId: target.userId, kind: "GM_GRANT_RUNE", meta: { ...spec, copies, reason: input.reason ?? null } }, session);
      return this.runes.grantRunes(session, target.userId, Array.from({ length: copies }, () => spec), { whenFull: "throw" });
    }) as RuntimeGrantedRune[];
    await this.runeCache.invalidate(target.userId);

    const runtime = await this.notifier.pushPlayerGrant(
      target.userId,
      { grantedAt: new Date().toISOString(), reason: normalizeReason(input.reason), runes },
      { targetLabel: target.username },
    );

    return { target, deliveryCount: runtime.deliveryCount, snapshot: runtime.snapshot, runes, rune: runes[0] ?? null };
  }

  async searchTargets(query: string, limit = 8) {
    const value = String(query || "").trim();
    if (!value) return [];

    const results = await this.users.search(value, Math.max(1, Math.min(20, Number(limit) | 0)));
    return results.map((user) => ({
      ...user,
      label: user.email ? `${user.username} (${user.email})` : user.username,
    }));
  }

  /** Player by id, username or email (throws when unknown). */
  async findTarget(selector: string): Promise<AdminUserRef> {
    return this.resolveTarget(selector);
  }

  private async resolveTarget(selector: string): Promise<AdminUserRef> {
    const value = String(selector || "").trim();
    if (!value) throw new Error("Target user is required.");
    const user = await this.users.resolve(value);
    if (!user) throw new Error("Target user not found.");
    return user;
  }
}

function normalizeReason(value: unknown): string | null {
  const reason = typeof value === "string" ? value.trim() : "";
  return reason.length > 0 ? reason : null;
}

function normalizeCopies(value: unknown): number {
  const copies = Number(value);
  return Number.isFinite(copies) ? Math.max(1, Math.min(100, Math.floor(copies))) : 1;
}
