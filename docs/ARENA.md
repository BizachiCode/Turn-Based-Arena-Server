# PvP arena (asynchronous)

Players attack other players' defense teams, which are played by the battle AI. Nobody has to be online at the same
time, so the arena works with few players and on the Offline backend (against NPC rivals only). This page has the
rules, the season system and how the server and the Unity client implement them. The messages are in
[`PROTOCOL.md`](PROTOCOL.md) (`arena`); the real-time friendly battles are in [`REALTIME_PVP.md`](REALTIME_PVP.md).

## Rules

| Item | Rule |
| --- | --- |
| Defense | 1–4 owned units + leader slot (`arena/setDefense`). A player without a defense cannot be found as opponent. |
| Attack team | 1–4 owned units + leader slot, chosen per battle. Same unit may be in defense and attack. |
| Entry cost | `wingCost` **Arena Wings** per attack (`AW`, default 1; 0 = free). The wing is a rechargeable currency (max and interval in `currencies.json`; the demo has max 10, +1 every 30 min). Paid by `battle_start_arena` (room `battle_pve`), not refunded on defeat or surrender. |
| Battle | battle-core mode `arena` (leader skills with `modeFilter: ["arena"]` apply), single wave, attacker controls his units (or auto), defender = AI. Turn limit from `arena.json` (`turnLimit`, default 60) → draw counts as defeat for the attacker. |
| Stats | Both teams use the full player build pipeline (runes, sets, team auras, leader skill), exactly like PvE player units. Defense units are snapshotted from the defender's roster **at battle start**. |
| Rating | Elo, start `1000`, K = `32`, floor `0`. Attacker: win `+delta`, loss `−delta`. Defender: mirror change (`−delta` on defense loss, `+delta` on defense win), clamped ≥ 0. NPC rivals have a fixed rating and never change. |
| Rewards | On attacker victory: `rewards.win` from `arena.json` (default `GP` glory points 10 + `GO` 2000). Loss: `rewards.loss` (default `GP` 2). Granted once per battle id (idempotent), in the final frame `result`. |
| Opponents | `arena/opponents` returns up to `opponentCount` (default 6): real players whose rating is within the first of `ratingWindows` (default ±200, then ±400, then any rating, closest first), excluding self and players attacked in the last `recentAttackHideSeconds` (default 600); the rest is filled with NPC rivals from `arena.json` closest in rating. Refresh: free every `freeRefreshSeconds` (default 600), otherwise costs `refreshCost` (default `DM` 5) or is rejected. List cached per player until refreshed or attacked. |
| Logs | Last `defenseLogSize` (default 20) defense results per player (`arena/defenseLog`): attacker name, win/loss, rating change, time. |
| Ranking | `arena/ranking`: top `rankingSize` (default 100) by rating + own rank. |
| Team | 4 slots, slots 0-1 are the front line (fixed: `ARENA_MAX_SLOTS` / `ARENA_FRONT_SLOTS`, the Unity formation screens are built for 4). |
| Seasons | Weekly seasons (default): tier of the final rating → rewards by mail, then a soft reset. See "Seasons" below. |

## Seasons

Configured in `arena.json` → `seasons` (exported from the Unity `ArenaConfig` "Seasons" fields; defaults below).

```jsonc
"seasons": {
  "enabled": true,
  "lengthDays": 7,                       // 1..365
  "anchor": "2026-01-05T00:00:00Z",      // UTC start of season 1 (exact format yyyy-MM-ddTHH:mm:ssZ)
  "minBattles": 1,                       // attacks needed in a season to get its reward (0 = everyone with a profile)
  "reset": { "base": 1000, "keepPercent": 50, "floor": 0 },
  "tiers": [                             // ascending minRating, the first at 0, unique ids ([A-Za-z0-9_-], max 32)
    { "id": "beginner",   "name": "Beginner",   "minRating": 0,    "rewards": [GP 50, GO 5000] },
    { "id": "challenger", "name": "Challenger", "minRating": 1100, "rewards": [GP 100, GO 10000] },
    { "id": "fighter",    "name": "Fighter",    "minRating": 1250, "rewards": [GP 200, GO 20000, DM 10] },
    { "id": "conqueror",  "name": "Conqueror",  "minRating": 1400, "rewards": [GP 350, GO 35000, DM 25] },
    { "id": "guardian",   "name": "Guardian",   "minRating": 1600, "rewards": [GP 500, GO 50000, DM 50] },
    { "id": "legend",     "name": "Legend",     "minRating": 1800, "rewards": [GP 800, GO 80000, DM 100] }
  ]                                      // rewards = [{ currencyId, amount }] like rewards.win
}
```

| Item | Rule |
| --- | --- |
| Season number | `floor((now - anchor) / lengthDays) + 1`; season N runs `[anchor + (N-1)·length, anchor + N·length)`. Before the anchor, season 1 runs until `anchor + length`. Changing `anchor`/`lengthDays` renumbers the seasons: profiles from a "future" number are adopted without settlement. |
| Tier | Highest tier with `minRating <= rating`. |
| Season end | The player's final rating → tier → `rewards` sent as a **system mail** (category `reward`, receipt key `arena_season:<n>`), claimed from the mailbox. Requires at least `minBattles` attacks (settled as attacker) in that season; defenses don't count. Tiers without rewards send no mail. |
| Soft reset | `newRating = max(floor, base + round((rating - base) * keepPercent / 100))` (JS `Math.round`), for **every** profile, rewarded or not: ratings are pulled toward `base` from both sides. `keepPercent` 0 = hard reset, 100 = no reset. Applied once per season boundary crossed (a player away for 3 seasons gets the reward of the season they played and 3 resets). |
| Settlement | Lazy and exactly once: every transaction that changes a rating (`arena/state`, battle settlement for the attacker **and** a real defender) first rolls the locked profile over to the running season, so the settled rating is the rating the season ended with. The rollover is a conditional update on the stored season number (`arena_profiles.season`) and the mail has a receipt key, so concurrent requests settle once. `arena/ranking` and `arena/opponents` settle an outdated profile first, too. A sweep job (`ArenaSeasonJob`, every 10 minutes and at boot) settles players who don't come back, so the ranking shows current-season ratings within one interval. |
| Battles across a boundary | A battle started in season N and finished in N+1 counts for N+1 and its Elo change applies to the reset ratings. |
| Profiles without a season | A profile with `season = 0` is adopted into the running season with its rating, nothing settled. |
| Announcement | The settled result is stored on the profile (`last_season_json`) and returned once as `seasonResult` by the next `arena/state` (`season_result_pending`). |
| Disabled | `enabled: false`: no settlement, no reset, `season`/`seasonResult` are `null`. |

Offline backend: `OfflineArenaService` applies the same rules (`ArenaSeasonRules`) when the player's arena state,
opponents, ranking or a battle settlement is requested, and mails the rewards through `OfflineMailService`.

## Server

The wire format is in [`PROTOCOL.md`](PROTOCOL.md) (`arena`). Notes that are not part of the wire format:

- The opponent list response carries `refreshedAt`, `nextFreeRefreshAt` and `refreshCost`, plus `wallet` after a paid
  refresh. The arena result also carries the `wallet` snapshot. Leaving an unfinished arena fight settles it as a
  defeat. A free refresh needs the previous refresh to be `freeRefreshSeconds` old (an attack-consumed list is
  rebuilt for free without touching that timer).
- Tables: `arena_profiles` (`user_id` primary and foreign key, `public_id` = the `u:<publicId>` handle, `rating`
  default 1000, `wins`, `losses`, `defense_wins`, `defense_losses`, `defense_json` with the uids and the leader slot,
  `opponents_json`, `opponents_refreshed_at`, `updated_at`, plus the season columns `season`, `season_battles`,
  `last_season_json`, `season_result_pending`) and `arena_battles` (`battle_id` primary key, `attacker_id`,
  `defender_id` null for NPC rivals, `npc_id`, `attacker_rating_before`, `rating_delta`, `defender_delta`, `result`
  win or loss, `rewards_granted`, `result_json`, `created_at`, `finished_at`).
- Module `src/modules/arena/`: `arena.room.ts` (room `arena`, authenticated), `arena.service.ts`,
  `arena.repository.ts` (Drizzle only, every query scoped by the session `userId`), `arena.validation.ts` (strict zod
  schemas), `arena-rating.ts` (pure Elo), `arena-season.ts` and `arena-season.service.ts` (seasons).
- Config: `src/config/ArenaCatalog.ts` reads `game_config/arena.json`: `turnLimit`, `kFactor`, `startRating`,
  `wingCost` (0..100), `opponentCount` (1..20), `ratingWindows` (ascending, at most 10), `freeRefreshSeconds`,
  `recentAttackHideSeconds` (0..604800), `defenseLogSize` (1..200), `rankingSize` (1..1000), `rewards.win` and
  `rewards.loss`, `refreshCost`, `npcRivals[]` (`{ id, name, rating, leaderSlotIndex, units: [{ characterId, star,
  level, awakeningIndex, skillLevels? }] }`) and `seasons`.
  The shipped `arena.json` has NPC rivals built from the sample characters.
- Opponents are offered as `{ opponentId ("u:<publicId>" | "npc:<id>"), name, rating, level, units: [{ characterId,
  star, level, element }] }`; internal user ids and rune details are never sent.
- The battle is served by the `battle_pve` room, so the PvE battle presenter is reused unchanged: the request
  `battle_start_arena` returns the same first frame shape as `battle_start`, and `battle_command`, `battle_auto`,
  `battle_surrender` and `battle_result` work as in PvE. When the battle finishes, the arena service applies rating and
  rewards in one transaction (idempotent per battle id), and the final frame `result` carries
  `{ victory, currencies, arena: { ratingBefore, ratingAfter, delta } }`.
- The wing is spent in the transaction that creates the battle. The attack is refused with `NOT_ENOUGH_CURRENCY`,
  `NO_DEFENSE` (the opponent has no defense), `OPPONENT_NOT_OFFERED` (the id is not in the player's current list) or
  `BATTLE_IN_PROGRESS`.
- Rate limits: the `query` and `mutation` limiters in the `arena` room, the `battle` limiter in `battle_pve`.
- Tests: `test/service_arena_test.ts` (Elo, opponent selection, idempotent rewards, defender rating, foreign uids
  rejected) and `test/service_arena_season_test.ts`.

## Unity client

- `IArenaBackend` in `BackendModules.cs`: `ArenaGetStateAsync`, `ArenaSetDefenseAsync`, `ArenaGetOpponentsAsync`,
  `ArenaGetDefenseLogAsync`, `ArenaGetRankingAsync` and `BattleArenaStartAsync` (returns `BattlePveActionResponseDTO`).
- Offline backend: `OfflineArenaService` uses NPC rivals only (from an `ArenaConfig` ScriptableObject exported to
  `arena.json`) and applies the same formulas to rating, wings and rewards. Battles run through
  `OfflineBattlePveService` with the mode `arena`.
- WebSocket backend: `WebSocketArenaHandler` (room `arena`) and `battle_start_arena` in `WebSocketBattlePveHandler`.
- `ArenaSession` (like `StageSession`) holds the selected opponent and formation. `TurnManagerPVE` starts with
  `BattleArenaStartAsync` when an arena session is set, `BattleResultPanel` shows the rating change, and Retry is
  disabled.
- `UIArena` has the rating, rank and wings header, the defense editor (the formation panel is reused), the opponent
  list with refresh, the defense log and the ranking tab. `ArenaJsonExporter` writes `arena.json` as part of the
  server export.
