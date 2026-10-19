// src/shared/errors/error-codes.ts
// All error codes — client uses these IDs to look up localized messages via LanguageManager

export const ErrorCode = {

  // ── Auth ──────────────────────────────────────────────────────────────
  AUTH_INVALID_PAYLOAD:        "AUTH_INVALID_PAYLOAD",
  AUTH_EMAIL_OR_USERNAME_TAKEN:"AUTH_EMAIL_OR_USERNAME_TAKEN",
  AUTH_INVALID_CREDENTIALS:    "AUTH_INVALID_CREDENTIALS",
  AUTH_ACCOUNT_LOCKED:         "AUTH_ACCOUNT_LOCKED",
  AUTH_BANNED:                 "AUTH_BANNED",
  AUTH_INVALID_REFRESH:        "AUTH_INVALID_REFRESH",
  AUTH_RATE_LIMIT:             "AUTH_RATE_LIMIT",
  AUTH_UNKNOWN_ACTION:         "AUTH_UNKNOWN_ACTION",

  // ── Account lifecycle (auth + account rooms) ─────────────────────────
  ACCOUNT_DELETION_PENDING:    "ACCOUNT_DELETION_PENDING",
  ACCOUNT_NOT_PENDING_DELETION:"ACCOUNT_NOT_PENDING_DELETION",
  ACCOUNT_NOT_GUEST:           "ACCOUNT_NOT_GUEST",
  ACCOUNT_IS_GUEST:            "ACCOUNT_IS_GUEST",
  ACCOUNT_WRONG_PASSWORD:      "ACCOUNT_WRONG_PASSWORD",
  ACCOUNT_SAME_PASSWORD:       "ACCOUNT_SAME_PASSWORD",

  // ── Economy ───────────────────────────────────────────────────────────
  ECON_INSUFFICIENT_FUNDS:     "ECON_INSUFFICIENT_FUNDS",
  ECON_CURRENCY_NOT_FOUND:     "ECON_CURRENCY_NOT_FOUND",
  ECON_INVALID_AMOUNT:         "ECON_INVALID_AMOUNT",
  ECON_FUSION_NOT_AVAILABLE:   "ECON_FUSION_NOT_AVAILABLE",
  ECON_INSUFFICIENT_INPUT:     "ECON_INSUFFICIENT_INPUT",
  ECON_INSUFFICIENT_COST:      "ECON_INSUFFICIENT_COST",

  // ── Roster ────────────────────────────────────────────────────────────
  ROSTER_INVALID_PAYLOAD:          "ROSTER_INVALID_PAYLOAD",
  ROSTER_CAPACITY_FULL:            "ROSTER_CAPACITY_FULL",
  ROSTER_CHARACTER_NOT_FOUND:      "ROSTER_CHARACTER_NOT_FOUND",
  ROSTER_CHARACTER_LOCKED:         "ROSTER_CHARACTER_LOCKED",
  ROSTER_WRONG_LOCATION:           "ROSTER_WRONG_LOCATION",
  ROSTER_AT_MAX_LEVEL:             "ROSTER_AT_MAX_LEVEL",
  ROSTER_FODDER_NOT_FOUND:         "ROSTER_FODDER_NOT_FOUND",
  ROSTER_CANNOT_CONSUME_TARGET:    "ROSTER_CANNOT_CONSUME_TARGET",
  ROSTER_FODDER_HAS_RUNES:         "ROSTER_FODDER_HAS_RUNES",
  ROSTER_INSUFFICIENT_STAR_POINTS: "ROSTER_INSUFFICIENT_STAR_POINTS",
  ROSTER_EVOLVE_STEP_MISSING:      "ROSTER_EVOLVE_STEP_MISSING",
  ROSTER_FULL:                     "ROSTER_FULL",
  ROSTER_IN_DEFENSE:               "ROSTER_IN_DEFENSE",
  ROSTER_CAPACITY_MAX:             "ROSTER_CAPACITY_MAX",

  // ── Summon ────────────────────────────────────────────────────────────
  NOT_ENOUGH_SCROLLS:              "NOT_ENOUGH_SCROLLS",
  INVALID_REQUEST:                 "INVALID_REQUEST",

  // ── Runes ─────────────────────────────────────────────────────────────
  RUNE_INVALID_PAYLOAD:        "RUNE_INVALID_PAYLOAD",
  RUNE_CAPACITY_FULL:          "RUNE_CAPACITY_FULL",
  RUNE_NOT_FOUND:              "RUNE_NOT_FOUND",
  RUNE_ALREADY_EQUIPPED:       "RUNE_ALREADY_EQUIPPED",
  RUNE_LOCKED:                 "RUNE_LOCKED",
  RUNE_AT_MAX_LEVEL:           "RUNE_AT_MAX_LEVEL",
  RUNE_DELETE_FAILED:          "RUNE_DELETE_FAILED",

  // ── Profile ───────────────────────────────────────────────────────────
  PROFILE_NAME_TAKEN:          "PROFILE_NAME_TAKEN",
  PROFILE_INVALID_ICON:        "PROFILE_INVALID_ICON",

  // ── Guild ─────────────────────────────────────────────────────────────
  GUILD_NOT_FOUND:             "GUILD_NOT_FOUND",
  GUILD_NAME_TAKEN:            "GUILD_NAME_TAKEN",
  GUILD_ALREADY_MEMBER:        "GUILD_ALREADY_MEMBER",
  GUILD_NOT_MEMBER:            "GUILD_NOT_MEMBER",
  GUILD_NO_PERMISSION:         "GUILD_NO_PERMISSION",
  GUILD_NAME_INVALID:          "GUILD_NAME_INVALID",
  GUILD_TEXT_TOO_LONG:         "GUILD_TEXT_TOO_LONG",
  GUILD_INVALID_ICON:          "GUILD_INVALID_ICON",
  GUILD_INVALID_TAG:           "GUILD_INVALID_TAG",
  GUILD_FULL:                  "GUILD_FULL",
  GUILD_LEVEL_TOO_LOW:         "GUILD_LEVEL_TOO_LOW",
  GUILD_REQUEST_EXISTS:        "GUILD_REQUEST_EXISTS",
  GUILD_REQUEST_LIMIT:         "GUILD_REQUEST_LIMIT",
  GUILD_REQUEST_NOT_FOUND:     "GUILD_REQUEST_NOT_FOUND",
  GUILD_LEADER_MUST_TRANSFER:  "GUILD_LEADER_MUST_TRANSFER",
  GUILD_OFFICER_LIMIT:         "GUILD_OFFICER_LIMIT",
  GUILD_INVALID_TARGET:        "GUILD_INVALID_TARGET",
  GUILD_QUESTS_DISABLED:       "GUILD_QUESTS_DISABLED",
  GUILD_QUEST_NOT_FOUND:       "GUILD_QUEST_NOT_FOUND",
  GUILD_QUEST_NOT_COMPLETE:    "GUILD_QUEST_NOT_COMPLETE",
  GUILD_QUEST_CLAIMED:         "GUILD_QUEST_CLAIMED",
  GUILD_CHEST_LOCKED:          "GUILD_CHEST_LOCKED",
  GUILD_CHEST_CLAIMED:         "GUILD_CHEST_CLAIMED",

  // ── Towers ────────────────────────────────────────────────────────────
  TOWER_LEVEL_LOCKED:          "TOWER_LEVEL_LOCKED",
  TOWER_FLOOR_LOCKED:          "TOWER_FLOOR_LOCKED",
  TOWER_FLOOR_CLEARED:         "TOWER_FLOOR_CLEARED",

  // ── Missions / achievements ───────────────────────────────────────────
  MISSIONS_DISABLED:           "MISSIONS_DISABLED",
  MISSION_NOT_FOUND:           "MISSION_NOT_FOUND",
  MISSION_NOT_COMPLETE:        "MISSION_NOT_COMPLETE",
  MISSION_CLAIMED:             "MISSION_CLAIMED",
  NEWBIE_QUESTS_DISABLED:      "NEWBIE_QUESTS_DISABLED",
  NEWBIE_QUEST_NOT_FOUND:      "NEWBIE_QUEST_NOT_FOUND",
  NEWBIE_QUEST_LOCKED:         "NEWBIE_QUEST_LOCKED",
  NEWBIE_QUEST_NOT_COMPLETE:   "NEWBIE_QUEST_NOT_COMPLETE",
  NEWBIE_QUEST_CLAIMED:        "NEWBIE_QUEST_CLAIMED",
  ATTENDANCE_DISABLED:         "ATTENDANCE_DISABLED",
  ATTENDANCE_CLAIMED:          "ATTENDANCE_CLAIMED",

  // ── Story / tutorial ──────────────────────────────────────────────────
  STORY_UNKNOWN_DIALOGUE:      "STORY_UNKNOWN_DIALOGUE",
  STORY_LOCKED:                "STORY_LOCKED",

  // ── Mail ──────────────────────────────────────────────────────────────
  MAIL_NOT_FOUND:              "MAIL_NOT_FOUND",
  MAIL_EXPIRED:                "MAIL_EXPIRED",
  MAIL_ALREADY_CLAIMED:        "MAIL_ALREADY_CLAIMED",
  MAIL_NOTHING_TO_CLAIM:       "MAIL_NOTHING_TO_CLAIM",
  MAIL_HAS_REWARDS:            "MAIL_HAS_REWARDS",

  // ── Rankings ──────────────────────────────────────────────────────────
  RANKING_DISABLED:            "RANKING_DISABLED",
  RANKING_UNKNOWN_CATEGORY:    "RANKING_UNKNOWN_CATEGORY",

  // ── Map / Battle ──────────────────────────────────────────────────────
  MAP_STAGE_NOT_FOUND:         "MAP_STAGE_NOT_FOUND",
  MAP_INSUFFICIENT_ENERGY:     "MAP_INSUFFICIENT_ENERGY",
  BATTLE_INVALID_FORMATION:    "BATTLE_INVALID_FORMATION",
  BATTLE_NOT_STARTED:          "BATTLE_NOT_STARTED",
  BATTLE_ID_MISMATCH:          "BATTLE_ID_MISMATCH",
  BATTLE_ALREADY_FINISHED:     "BATTLE_ALREADY_FINISHED",
  BATTLE_IN_PROGRESS:          "BATTLE_IN_PROGRESS",
  BATTLE_NOT_FINISHED:         "BATTLE_NOT_FINISHED",
  STAGE_NOT_VALIDATED:         "STAGE_NOT_VALIDATED",

  // ── Shop ──────────────────────────────────────────────────────────────
  SHOP_ITEM_NOT_FOUND:         "SHOP_ITEM_NOT_FOUND",
  SHOP_NOT_AVAILABLE:          "SHOP_NOT_AVAILABLE",
  SHOP_NOT_ELIGIBLE:           "SHOP_NOT_ELIGIBLE",
  SHOP_LIMIT_REACHED:          "SHOP_LIMIT_REACHED",
  PRICE_CHANGED:               "PRICE_CHANGED",
  SHOP_REWARD_NOT_SUPPORTED:   "SHOP_REWARD_NOT_SUPPORTED",
  SHOP_ALREADY_OWNED:          "SHOP_ALREADY_OWNED",

  // ── Real-money purchases (docs/IAP.md) ────────────────────────────────
  /** The receipt's store is not set up on this server (package name / bundle id / credentials), or no receipt was sent. */
  IAP_NOT_SUPPORTED:           "IAP_NOT_SUPPORTED",
  /** The store says the purchase is not valid (unknown, refunded, cancelled, other app, other product, test purchase refused). */
  IAP_RECEIPT_REJECTED:        "IAP_RECEIPT_REJECTED",
  /** The transaction was already delivered to another account. */
  IAP_RECEIPT_USED:            "IAP_RECEIPT_USED",
  /** The receipt is for another product than the item's current price. */
  IAP_PRODUCT_MISMATCH:        "IAP_PRODUCT_MISMATCH",
  /** Demo receipt while demo purchases are off. */
  IAP_DEMO_DISABLED:           "IAP_DEMO_DISABLED",
  /** The payment is still pending at the store (e.g. cash payment): retry later. */
  IAP_PURCHASE_PENDING:        "IAP_PURCHASE_PENDING",
  /** The store could not be reached (or rejected the server credentials): retry later, the purchase is kept. */
  IAP_STORE_UNAVAILABLE:       "IAP_STORE_UNAVAILABLE",

  // ── Arena ─────────────────────────────────────────────────────────────
  NOT_ENOUGH_CURRENCY:         "NOT_ENOUGH_CURRENCY",
  NO_DEFENSE:                  "NO_DEFENSE",
  OPPONENT_NOT_OFFERED:        "OPPONENT_NOT_OFFERED",
  UNIT_NOT_OWNED:              "UNIT_NOT_OWNED",
  ARENA_REFRESH_NOT_AVAILABLE: "ARENA_REFRESH_NOT_AVAILABLE",

  // ── Chat ──────────────────────────────────────────────────────────────
  CHAT_MUTED:                  "CHAT_MUTED",
  CHAT_RATE_LIMIT:             "CHAT_RATE_LIMIT",
  /** Chat word filter in block mode refused the line (`chat` / `guild_chat` `send`). */
  MESSAGE_BLOCKED:             "MESSAGE_BLOCKED",
  /** Word filter (block mode) refused a nickname or a guild name / description / notice. */
  TEXT_BLOCKED:                "TEXT_BLOCKED",

  // ── Social: friends, private messages, friendly battles ───────────────
  FRIENDS_DISABLED:            "FRIENDS_DISABLED",
  PLAYER_NOT_FOUND:            "PLAYER_NOT_FOUND",
  /** The target is the player themself. */
  SOCIAL_SELF:                 "SOCIAL_SELF",
  FRIEND_ALREADY:              "FRIEND_ALREADY",
  FRIEND_NOT_FOUND:            "FRIEND_NOT_FOUND",
  FRIEND_REQUEST_NOT_FOUND:    "FRIEND_REQUEST_NOT_FOUND",
  /** The caller's friends list is full. */
  FRIEND_LIST_FULL:            "FRIEND_LIST_FULL",
  /** The other player's friends list is full. */
  FRIEND_TARGET_LIST_FULL:     "FRIEND_TARGET_LIST_FULL",
  /** Too many requests of the caller are waiting for an answer. */
  FRIEND_TOO_MANY_REQUESTS:    "FRIEND_TOO_MANY_REQUESTS",
  /** The other player has too many requests waiting. */
  FRIEND_TARGET_REQUESTS_FULL: "FRIEND_TARGET_REQUESTS_FULL",
  /** The other player does not accept requests from the caller (blocked); deliberately vague. */
  FRIEND_REQUEST_REFUSED:      "FRIEND_REQUEST_REFUSED",
  /** The caller blocked this player (unblock first). */
  PLAYER_BLOCKED:              "PLAYER_BLOCKED",
  BLOCK_LIST_FULL:             "BLOCK_LIST_FULL",
  DM_DISABLED:                 "DM_DISABLED",
  /** Private messages need a friendship (or a shared guild when allowed). */
  DM_NOT_ALLOWED:              "DM_NOT_ALLOWED",
  FRIENDLY_DISABLED:           "FRIENDLY_DISABLED",
  /** Friendly battles need a friendship (or a shared guild when allowed). */
  FRIENDLY_NOT_ALLOWED:        "FRIENDLY_NOT_ALLOWED",
  FRIENDLY_TARGET_OFFLINE:     "FRIENDLY_TARGET_OFFLINE",
  FRIENDLY_TARGET_BUSY:        "FRIENDLY_TARGET_BUSY",
  /** The caller already has a pending challenge or a running battle. */
  FRIENDLY_BUSY:               "FRIENDLY_BUSY",
  FRIENDLY_CHALLENGE_NOT_FOUND:"FRIENDLY_CHALLENGE_NOT_FOUND",
  FRIENDLY_CHALLENGE_EXPIRED:  "FRIENDLY_CHALLENGE_EXPIRED",
  FRIENDLY_MATCH_FAILED:       "FRIENDLY_MATCH_FAILED",

  // ── Player reports ────────────────────────────────────────────────────
  REPORTS_DISABLED:            "REPORTS_DISABLED",
  REPORT_CATEGORY_INVALID:     "REPORT_CATEGORY_INVALID",
  REPORT_SELF:                 "REPORT_SELF",
  REPORT_TARGET_NOT_FOUND:     "REPORT_TARGET_NOT_FOUND",
  REPORT_MESSAGE_NOT_FOUND:    "REPORT_MESSAGE_NOT_FOUND",
  REPORT_DUPLICATE:            "REPORT_DUPLICATE",
  REPORT_COOLDOWN:             "REPORT_COOLDOWN",
  REPORT_LIMIT:                "REPORT_LIMIT",

  // ── Home ──────────────────────────────────────────────────────────────
  HOME_INVALID_PAYLOAD:        "HOME_INVALID_PAYLOAD",
  HOME_ISLAND_NOT_FOUND:       "HOME_ISLAND_NOT_FOUND",
  HOME_DEFINITION_NOT_FOUND:   "HOME_DEFINITION_NOT_FOUND",
  HOME_OBJECT_NOT_FOUND:       "HOME_OBJECT_NOT_FOUND",
  HOME_NOT_PURCHASABLE:        "HOME_NOT_PURCHASABLE",
  HOME_NOT_MOVEABLE:           "HOME_NOT_MOVEABLE",
  HOME_NOT_REMOVABLE:          "HOME_NOT_REMOVABLE",
  HOME_LOCKED:                 "HOME_LOCKED",
  HOME_LIMIT_REACHED:          "HOME_LIMIT_REACHED",
  HOME_INVALID_FOOTPRINT:      "HOME_INVALID_FOOTPRINT",
  HOME_OUT_OF_BOUNDS:          "HOME_OUT_OF_BOUNDS",
  HOME_CELL_BLOCKED:           "HOME_CELL_BLOCKED",
  HOME_OVERLAP:                "HOME_OVERLAP",
  HOME_ISLAND_LOCKED:          "HOME_ISLAND_LOCKED",
  HOME_ISLAND_ALREADY_UNLOCKED: "HOME_ISLAND_ALREADY_UNLOCKED",
  HOME_NO_PRODUCTION:          "HOME_NO_PRODUCTION",
  HOME_NOTHING_TO_COLLECT:     "HOME_NOTHING_TO_COLLECT",
  HOME_PRODUCTION_SLOTS_FULL:  "HOME_PRODUCTION_SLOTS_FULL",
  HOME_UNIT_NOT_FOUND:         "HOME_UNIT_NOT_FOUND",
  HOME_UNIT_BUSY:              "HOME_UNIT_BUSY",

  // ── Idempotent requests (`requestId`) ─────────────────────────────────
  /** A `requestId` was already used for another kind of request (or its first call has not finished). */
  REQUEST_ID_CONFLICT:         "REQUEST_ID_CONFLICT",

  // ── Generic ───────────────────────────────────────────────────────────
  SERVER_ERROR:                "SERVER_ERROR",
  UNAUTHORIZED:                "UNAUTHORIZED",
  NOT_FOUND:                   "NOT_FOUND",
  RATE_LIMIT:                  "RATE_LIMIT",
  MAINTENANCE:                 "MAINTENANCE",
  INVALID_PAYLOAD:             "INVALID_PAYLOAD",
  FORBIDDEN:                   "FORBIDDEN",

} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];
