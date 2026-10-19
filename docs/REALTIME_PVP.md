# Real-time PvP

Two players fight a live turn-based battle against each other. Friendly battles between friends and guild mates are
implemented. A ranked queue with a draft, seasons and tournaments are planned and not implemented; the second half of
this page is the design for them. Real-time PvP is online only: the Offline backend has none (it could offer a practice
battle against the AI with the same screens). The asynchronous arena is a separate feature, see
[`ARENA.md`](ARENA.md).

## Friendly battles (implemented)

- The challenge flow lives in the `social` room (`challenge/send`, `accept`, `decline`, `cancel`, `list`; the pushes
  `friendly_*` arrive as `social_event`). A challenge and its match share one row of the table `friendly_matches`.
  Tuning is in `social.json > friendlyBattle`.
- The match room is `battle_pvp` (`src/modules/battle-pvp/`). Only the server can create it (the creation needs an HMAC
  ticket), it has two seats, and it moves through the phases lobby, prepare (team lock, with the arena defense as a
  fallback), battle and finished. A turn timer plays the unit with the AI on timeout, a dropped player keeps the seat
  for a reconnection window, and a player who does not return forfeits. Both players are held in the live battle
  registry (`src/shared/rooms/active-battles.ts`).
- `PvpBattleSession` (`pvp-battle-session.ts`) runs two human sides on the battle-core engine, with every turn order
  system including TeamPhase. It exists only on the server and is not part of the battle-core port to C#. The frames
  are built per player (`pvp-frames.ts`): `localSideId`, only the player's own action options, and the opponent's
  identities stripped.
- The messages are in [`PROTOCOL.md`](PROTOCOL.md), rooms [`social`](PROTOCOL.md#social) and
  [`battle_pvp`](PROTOCOL.md#battle_pvp).

## Ranked mode and tournaments (planned)

The ranked mode reuses the friendly battle room: the queue only has to create the same kind of room, a `battle_pvp`
variant with a draft phase instead of the free team lock, and a rating instead of `friendly: true`. Nothing below
exists in the code yet.

### Match flow

1. **Queue.** A room `pvp_queue` (authenticated). `queue/join { mode: "ranked" | "casual" }` matches two players by
   MMR (Elo or Glicko, start 1200), widening the window every 10 s (from 50 to 400). `queue/leave` leaves the queue.
   On a match the server creates a `pvp_match` room and pushes `match_found { roomId, reservation }` to both clients
   (Colyseus seat reservations; the clients join with `consumeSeatReservation`).
2. **Draft (pick and ban).** In `pvp_match` each player sends a pool of 15 owned units (`draft/pool`, validated by
   ownership). Snake picks 1-2-2-2-2-1 give 5 units each, then each player bans one enemy pick (`draft/pick`,
   `draft/ban`). The leader is the first pick, or `draft/leader`. Each step takes 30 s, with an auto-pick on timeout.
   The draft is a Colyseus `@colyseus/schema` state (phase, timers, picks, bans) that both clients render live.
3. **Battle.** A battle-core session with both sides player-controlled (`isPlayerControlled` on both teams; the session
   waits for input from whichever side owns the active unit). The mode is `pvp` (a new `BattleModes.Pvp`); whether leader
   skills with `modeFilter` `arena` also apply to it is still to be decided. Only the active player may send
   `battle_command` or `battle_auto`; a turn timer expiry also triggers auto. Both clients receive every frame as the
   push `battle_frame` in the `BattlePveActionResponseDTO` shape, so the PvE presenter is reused (with a "remote
   player's turn" indicator). The turn timer is 30 s with a reserve bank. A disconnected player is replaced by the AI
   for up to 60 s (Colyseus `allowReconnection`), then forfeits.
4. **Result.** The MMR of both players is updated, season points are added, and the match is stored in a `pvp_matches`
   table with the full command log and the seed. Replays are deterministic: the same seed and commands give the same
   battle in battle-core and in the C# port.

### Fairness and security

- The server is authoritative: clients send intents only, and the stats come from the server roster snapshot at the
  end of the draft.
- An optional fair mode for tournaments puts all units at maximum level and skills with a fixed rune preset from the
  config.
- Commands are rate limited, commands for units the sender does not control are rejected, and a user can be in one
  match at a time.
- Basic anti-collusion: no repeated matches against the same opponent within N minutes in ranked.

### Seasons and tournaments

- Seasons (`pvp_seasons`: id, start and end, reward tiers by rank or MMR) grant their rewards from a server job at the
  end of the season.
- Tournaments (`tournaments`, `tournament_entries`, `tournament_matches`) have a sign-up window, a Swiss or
  single-elimination bracket and scheduled rounds. Both players get a match room at the start of a round (a no-show
  forfeits after 5 minutes), results advance the bracket, and prizes come from the config. Admin endpoints under
  `/admin/runtime` create and cancel tournaments.
- Spectating, later: read-only clients join the match room and receive the frames with a delay.

### Unity

- `IPvpBackend`: queue join and leave, match events, draft actions, battle commands and results. It works with the
  WebSocket backend only; the Offline backend answers `UNSUPPORTED` except for a practice battle against the AI.
- UI: a queue screen (timer, cancel), a draft screen (pool, picks and bans with timers), the battle scene with the
  existing presenter plus a turn timer and the opponent's name and rank, a result screen with the MMR change, and
  season and tournament screens.
