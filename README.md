# Turn-Based Arena: authoritative server

Colyseus 0.18 + TypeScript server for the **Turn-Based Arena** Unity template (a monster-collecting turn-based RPG with
PvE stages, summons, runes, a shop, chat, guilds, an asynchronous arena and a home island). The server owns every rule:
battles, rewards, currencies, drops and purchases are computed here, and the Unity client only sends intents.

The Unity project also ships an Offline backend that runs the same rules locally in C#. You can build the game offline
first and switch to this server later without changing gameplay code.

Contents: [Requirements](#requirements) | [Quick start](#quick-start-development) |
[Connecting the Unity client](#connecting-the-unity-client) | [Configuration](#configuration) |
[Production](#production) | [Database](#database) | [Scripts and tests](#scripts-and-tests) |
[Project layout](#project-layout) | [Documentation](#documentation)

## Requirements

| Tool | Version |
| --- | --- |
| Node.js | 20.9 or newer |
| MySQL / MariaDB | MySQL 8+ or MariaDB 10.5+ (XAMPP works) |
| Redis | 6+. Active sessions and caches live there, so players cannot log in without it. On Windows use Memurai or WSL. |

## Quick start (development)

```bash
npm install
npm start
```

On the first start the server:

1. creates `.env` from `.env.example` with freshly generated secrets (development only; the admin key is
   `CONFIG_API_KEY`). The defaults are MySQL `root` without a password on `127.0.0.1:3306`, Redis on `127.0.0.1:6379`
   and port `2567`. Edit `MYSQL_*` and `REDIS_*` in `.env` if yours differ;
2. creates the database (`game_arena_db`) if it does not exist;
3. applies the migrations in `drizzle/` (the first run creates every table);
4. loads the game configuration from `game_config/`.

`npm start` restarts the server whenever a source file changes. The server needs a `config.json` in `game_config/`
and refuses to start without one; the folder ships with a sample export.

## Connecting the Unity client

1. In Unity, select the `BackendSettingsSetup` asset (`Core/DataHandler/Backend/Settings`), set **Option** to
   `WebSocketSql` and **Server Url** to your server (default `ws://127.0.0.1:2567`). **Admin Http Base** is the same
   address with `http://`.
2. Open **Tools > Turn-Based Arena > Export Server Config**. The window uploads the bundle to `/admin/config/import`
   (it asks for `CONFIG_API_KEY`, which stays in your EditorPrefs and never in a build) or saves a zip that you can
   import later. An import is applied immediately, without a restart.

## Configuration

### Environment

Settings come from `.env` (see `.env.example`, which documents every variable). The ones you usually touch:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `2567` | HTTP and WebSocket port |
| `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE` | `127.0.0.1`, `3306`, `root`, empty, `game_arena_db` | database connection; the user needs `CREATE` rights on the first run |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_DB`, `REDIS_KEY_PREFIX` | `127.0.0.1`, `6379`, empty, `0`, `arena:` | Redis connection |
| `JWT_ACCESS_SECRET`, `PASSWORD_PEPPER`, `REFRESH_PEPPER` | generated in development | secrets; see [Production](#production) |
| `CONFIG_API_KEY` | generated in development | admin key for `/admin/*` and the GM panel; empty disables both |
| `ADMIN_ALLOWED_IPS` | empty (any address) | restricts `/admin/*`, `/gm` and `/monitor` to these IPs or CIDR ranges |
| `CORS_ORIGINS` | empty | comma-separated web origins allowed to call the HTTP API (WebGL builds only) |
| `TRUST_PROXY`, `TRUSTED_PROXIES` | `false`, empty | set both behind a reverse proxy, see [`docs/SECURITY.md`](docs/SECURITY.md) |
| `DB_AUTO_MIGRATE` | `true` outside production | apply migrations on boot |
| `RATE_LIMIT_STORE` | `memory`, `redis` in production | where the rate limit buckets live; use `redis` with several processes |
| `LOG_CONSOLE` | `none` | what the terminal prints (`none`, `error`, `all`); the logs are always readable in the GM panel |
| `CONFIG_DIR` | `./game_config` | folder with the exported game data |
| `MAINTENANCE_MODE` | `false` | start in maintenance mode |
| `MAX_CONNECTIONS_PER_USER`, `MAX_CONNECTIONS_PER_USER_PER_ROOM` | `64`, `8` | room connections allowed per account (0 = unlimited) |
| `ACCOUNT_DELETION_GRACE_DAYS` | `30` | days between a deletion request and the permanent delete |
| `IAP_DEMO_PURCHASES`, `GOOGLE_PLAY_SERVICE_ACCOUNT_*`, `APPLE_*` | | real-money purchases, see [`docs/IAP.md`](docs/IAP.md) |

### Game data

Characters, skills, leader skills, combat formulas, maps, stage rewards, runes, summons, the shop, homes and the other
game systems are authored in Unity ScriptableObjects and exported to JSON, so both backends use the same data. The
files in `game_config/` are read at start and replaced by every import:

| File | Content | Read by |
| --- | --- | --- |
| `config.json` | gameplay rules (star tiers, account EXP, selling, capacity, power-up, evolve), nickname and chat rules, reports, tutorial summons | `LiveConfigCatalog.ts`, `game-config.schema.ts` |
| `characters.json`, `leader_skills.json`, `combat_config.json` | monsters and their skills, leader skills, battle formulas and turn order | `CharacterCatalog.ts`, `LeaderSkillCatalog.ts`, `CombatFormulaCatalog.ts` |
| `maps.json`, `dungeons.json`, `towers.json` | story regions and stages, drop tables, elemental halls, towers | `MapCatalog.ts`, `DungeonCatalog.ts`, `TowerCatalog.ts` |
| `currencies.json`, `icons.json` | currencies (caps, recharge, fusion), profile icons | `CurrencyCatalog.ts`, `IconCatalog.ts` |
| `summons.json`, `shop.json`, `homes.json` | summon scrolls, shop items and IAP settings, home buildings and islands | `SummonCatalog.ts`, `ShopCatalog.ts`, `HomeCatalog.ts` |
| `rune_sets.json`, `rune_slot_rules.json`, `rune_main_curves.json`, `rune_substat_rolls.json`, `rune_grinds.json`, `rune_config.json` | rune sets and rules | `RuneCatalog.ts` |
| `arena.json`, `ranking.json`, `social.json` | arena rules, NPC rivals and seasons; leaderboards; friends, private messages, friendly battles | `ArenaCatalog.ts`, `RankingCatalog.ts`, `SocialCatalog.ts` |
| `guild.json`, `mail.json`, `missions.json`, `new_player_quests.json`, `attendance.json`, `dialogues.json` | guilds and guild quests, mailbox, daily missions and achievements, beginner quest book, daily check-in, tutorial and story dialogues | the matching `*Catalog.ts` in `src/config/` |

An import also keeps a copy of the uploaded files in `game_config/bundle_<timestamp>/` (not committed). When both a
file and a bundle copy exist, the server loads the most recently modified one. There is no separate format document:
the JSON shape of each file is the zod schema in the catalog listed above, and the part of it that reaches clients is
described per room in [`docs/PROTOCOL.md`](docs/PROTOCOL.md).

## Production

```bash
npm run build
NODE_ENV=production npm run start:prod      # or: pm2 start ecosystem.config.cjs
```

`ecosystem.config.cjs` starts one process per CPU core. Several processes need `RATE_LIMIT_STORE=redis` (the
production default); the per-account connection caps are counted per process.

In production the server refuses to start with missing, default or short secrets. Set at least:

- `JWT_ACCESS_SECRET`, `PASSWORD_PEPPER`, `REFRESH_PEPPER`: long random strings (`openssl rand -base64 48`)
- `CONFIG_API_KEY`: the admin key, 16 characters at minimum (use 32 or more)
- `MYSQL_*`, `REDIS_*`: your database and cache
- `CORS_ORIGINS`: if browsers call the HTTP API

Migrations run on boot only when `DB_AUTO_MIGRATE=true`; otherwise run `npm run db:migrate` during deployment.
`GET /health` reports the server state for a load balancer. Serve the GM panel (`/gm`) and `/admin` over TLS.

## Database

The schema is defined in `src/infrastructure/database/schema/*.ts` and applied from `drizzle/`. To change it:

```bash
# edit src/infrastructure/database/schema/*.ts
npm run db:generate   # writes a new migration into drizzle/
npm start             # applies it
```

`npm run db:migrate` creates the database if needed, applies the migrations and exits. `npm run db:studio` opens
Drizzle Studio.

## Scripts and tests

| Script | What it does |
| --- | --- |
| `npm start` | development server with reload |
| `npm run build` | compile to `build/` |
| `npm run start:prod` | run the compiled server |
| `npm run typecheck` | type-check `src/` and `test/` |
| `npm test` | unit tests (battle rules, services, validation); no database or Redis needed |
| `npm run test:e2e` | end-to-end test against a real MySQL and Redis; uses the database `arena_e2e` (`E2E_MYSQL_DATABASE`) and port 2580 (`E2E_PORT`), and skips itself when MySQL is down |
| `npm run db:generate`, `db:migrate`, `db:studio` | Drizzle schema tools |
| `npm run pentest:rooms`, `npm run pentest:http` | black-box security suites against a running dev server, see [`tools/pentest/README.md`](tools/pentest/README.md) |
| `npm run loadtest` | Colyseus load test (guest accounts joining the `presence` room) |

Two more tools: `npx tsx tools/sim/smoke-battles.ts` plays automatic battles with every character in every turn order
mode to check a balance sheet, and `node tools/fetch-wordlists.mjs` refreshes the chat filter word lists
([`wordlists/README.md`](wordlists/README.md)).

## Project layout

```
src/
  app/              composition root (container.ts) and HTTP routes
  bootstrap/        first-run .env creation, log setup
  config/           env validation and the catalogs for game_config/*.json
  infrastructure/   Drizzle (MySQL), Redis, logging, scheduled jobs, runtime state
  modules/          one folder per feature: room (transport) -> service (rules) -> repository (Drizzle)
    battle-core/    pure battle engine, ported 1:1 to C# for the Offline backend (parity scenarios)
  shared/           errors, validation, room base classes, security helpers
drizzle/            SQL migrations
game_config/        exported game data
docs/               protocol and rules documentation
test/               unit tests (mocha) and the end-to-end test
tools/              pentest suites, battle simulation, word list fetcher
wordlists/          server-only chat filter word lists
```

## Documentation

The full template guide (Unity project, game data, server setup and an Ubuntu deployment walkthrough) is online at
https://bizachi-dev.gitbook.io/turn-based-arena-template/. The Unity template is on the Asset Store:
https://assetstore.unity.com/packages/slug/414890. Support: https://discord.com/invite/EGGj77g3eQ.

| Document | Covers |
| --- | --- |
| [`docs/PROTOCOL.md`](docs/PROTOCOL.md) | every room, request, response and push, plus the GM panel HTTP API |
| [`docs/BATTLE_RULES.md`](docs/BATTLE_RULES.md) | combat formulas and rules |
| [`docs/BATTLE_EVENTS.md`](docs/BATTLE_EVENTS.md) | the battle event stream that the client presents |
| [`docs/ARENA.md`](docs/ARENA.md) | the asynchronous PvP arena and its seasons |
| [`docs/REALTIME_PVP.md`](docs/REALTIME_PVP.md) | friendly real-time battles and the planned ranked mode |
| [`docs/IAP.md`](docs/IAP.md) | real-money purchases, demo mode, adding a store |
| [`docs/SECURITY.md`](docs/SECURITY.md) | security model and the checklist for new features |
| [`tools/pentest/README.md`](tools/pentest/README.md) | the security test suites |

## License

See the Unity Asset Store EULA that came with your purchase.
