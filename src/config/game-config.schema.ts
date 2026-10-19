// src/config/game-config.schema.ts
// Zod schema of config.json (exported by the Unity "Export Server Config" window).

import { z } from "zod";

/* -----------------------------------------------------------------------------
 * Core building blocks
 * -------------------------------------------------------------------------- */

/** Star tier definition used by level/exp curves. */
export const StarTierSchema = z.object({
  stars: z.number().int().min(1).max(6),
  maxLevel: z.number().int().min(1).max(200),
  /** EXP for transitions: Lv.1->2 at index 0, ... */
  expPerLevel: z.array(z.number().int().nonnegative()).default([]),
});

/** Nickname rules for player profile. */
export const NicknameRulesSchema = z.object({
  minLength: z.number().int().min(1).max(128),
  maxLength: z.number().int().min(1).max(256),
  canUseSpecialChar: z.boolean(),
});

/** Player capacity knobs (exported by Unity, consumed by server). */
export const PlayerCapacitySchema = z.object({
  /** Initial unlocked BAG capacity for new players. */
  initialBagCapacity: z.number().int().min(1).max(50000).default(100),
  /** Maximum BAG capacity allowed (admin tools / clamps). */
  maxBagCapacity: z.number().int().min(1).max(50000).default(500),
  /** Initial unlocked STORAGE capacity. */
  initialStorageCapacity: z.number().int().min(1).max(500000).default(500),
  /** Maximum STORAGE capacity allowed. */
  maxStorageCapacity: z.number().int().min(1).max(500000).default(2000),
});

/* -----------------------------------------------------------------------------
 * NEW: Power-Up / Evolve (server is source of truth)
 * -------------------------------------------------------------------------- */

const StarMultiplierSchema = z.object({
  stars: z.number().int().min(1).max(6),
  factor: z.number().nonnegative(),
  /** Flat EXP every fodder of this tier gives on top of its accumulated EXP x factor. */
  baseExp: z.number().int().nonnegative().default(0),
});

export const PowerUpRulesSchema = z.object({
  currencyId: z.string().min(1).default("GO"),
  costPerFodderStarUnit: z.number().int().nonnegative().default(600),
  expMultiplierByStars: z.array(StarMultiplierSchema).default([]),
  minFodderBaseLevel: z.number().int().min(1).max(200).default(2),
  expYieldMode: z.string().default("AccumulatedToLevel"),
});

const EvolveStepSchema = z.object({
  fromStars: z.number().int().min(1).max(5),
  toStars: z.number().int().min(2).max(6),
  /** Total star points required for this evolve step. */
  requiredStarPoints: z.number().int().nonnegative().default(0),
});

export const EvolveRulesSchema = z.object({
  currencyId: z.string().min(1).default("GO"),
  costPerStarUnit: z.number().int().nonnegative().default(600),
  steps: z.array(EvolveStepSchema).default([]),
});
/* -----------------------------------------------------------------------------
 * Root config
 * -------------------------------------------------------------------------- */

export const GameServerConfigSchema = z
  .object({
    version: z.string().default("1.0.0"),
    exportedAtIsoUtc: z.string().optional(),

    auth: z.object({
      minPassword: z.number().int().min(1).max(128),
      maxPassword: z.number().int().min(1).max(256),
      requireUppercase: z.boolean(),
      requireSpecial: z.boolean(),
    }),

    gameplay: z.object({
      starTiers: z.array(StarTierSchema).nonempty(),
      accountExp: z.object({
        maxLevel: z.number().int().min(1),
        expPerLevel: z.array(z.number().int().nonnegative()),
        /** Account EXP per energy spent on a won stage (a stage's own `accountExp` overrides it). */
        expPerEnergy: z.coerce.number().min(0).max(10000).default(10),
        /** Currencies granted when a level is reached. */
        levelUpRewards: z.array(z.object({
          level: z.coerce.number().int().min(2),
          currencies: z.array(z.object({ currencyId: z.string().min(1), amount: z.coerce.number().int().positive() })).default([]),
        })).default([]),
        /** Currencies refilled to their cap on every level up (energy refill). */
        refillOnLevelUp: z.array(z.string().min(1)).default([]),
      }),
      /** Selling monsters: price = priceByStars[stars] + pricePerLevel x (level - 1). */
      monsterSell: z.object({
        currencyId: z.string().min(1).default("GO"),
        priceByStars: z.array(z.coerce.number().int().min(0)).default([0, 300, 800, 2000, 6000, 20000, 60000]),
        pricePerLevel: z.coerce.number().int().min(0).default(50),
      }).prefault({}),
      /** Buying monster bag / storage slots: `step` slots per purchase, price = costBase + costIncrement x purchases. */
      capacityExpansion: z.object({
        bag: z.object({
          step: z.coerce.number().int().min(1).default(5),
          currencyId: z.string().min(1).default("GO"),
          costBase: z.coerce.number().int().min(0).default(20000),
          costIncrement: z.coerce.number().int().min(0).default(10000),
        }).prefault({}),
        storage: z.object({
          step: z.coerce.number().int().min(1).default(25),
          currencyId: z.string().min(1).default("GO"),
          costBase: z.coerce.number().int().min(0).default(30000),
          costIncrement: z.coerce.number().int().min(0).default(10000),
        }).prefault({}),
      }).prefault({}),

      playerCapacity: PlayerCapacitySchema.default({
        initialBagCapacity: 100,
        maxBagCapacity: 500,
        initialStorageCapacity: 500,
        maxStorageCapacity: 2000,
      }),

      /** Power-up rules (defaults keep the server functional). */
      powerUp: PowerUpRulesSchema,
      /** Evolve rules (defaults keep the server functional). */
      evolve: EvolveRulesSchema,
      /** Minutes a paid `stage/validateStart` ticket stays usable for `battle_start`. */
      stageStartTicketMinutes: z.coerce.number().int().min(1).max(1440).default(30),
    }),
    /** Profile-level options; nickname rules are here. */
    profile: z
      .object({
        nickname: NicknameRulesSchema,
      })
      .default({
        nickname: { minLength: 3, maxLength: 25, canUseSpecialChar: true },
      }),
  })
  // Keep unknown keys instead of stripping them (useful for staged rollouts).
  .passthrough();

export type GameServerConfig = z.infer<typeof GameServerConfigSchema>;
export type NicknameRules = z.infer<typeof NicknameRulesSchema>;
export type PlayerCapacity = z.infer<typeof PlayerCapacitySchema>;
