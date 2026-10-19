# Security model

How the server protects the game and the operator. The server is the single source of truth: clients send intents
(ids, choices), and every number that matters (prices, rewards, stats, levels, EXP) is computed on the server from the
exported game config and the database. The sections follow the usual attack classes; the last one is a checklist for
new features. The messages themselves are described in [`PROTOCOL.md`](PROTOCOL.md), and the black-box test suites
that attack a running server are in [`tools/pentest/README.md`](../tools/pentest/README.md).

## Injection
- Drizzle ORM is the only database layer. All queries use the query builder; the `sql` template
  is only used for atomic increments (`count + 1`), `COALESCE` and identifiers, and it always binds
  values as parameters. `CREATE DATABASE` uses mysql2's `??` identifier placeholder.
- A search for raw `.query(` calls in `src` finds only constant statements (`SET time_zone = '+00:00'` and the
  `CREATE DATABASE` above), the Colyseus room listing `matchMaker.query`, and the log repository's own `query` method.

## Broken object level authorization (BOLA / IDOR)
- The user id always comes from the authenticated room identity (`client.auth`), never from the
  payload; strict schemas reject a payload `userId` like any other unknown field.
- Every repository method that touches player-owned rows (characters, runes, wallet, home objects,
  building inventory, shop counters, stage progress, battles, arena profile/defense/battles) has `user_id = <session user>` in its `WHERE` clause, so a
  foreign uid simply "does not exist" (`*_NOT_FOUND` / `WRONG_LOCATION` / `UNIT_NOT_OWNED`).
- Battle sessions are bound to the user who started them; `battleId` mismatches are rejected and
  rewards are looked up by `(battle_id, user_id)`.
- Guild chat (`guild_chat`): the client never names a guild. The channel is read from `guild_members` for the session
  user on join, `history` and `send` (`GUILD_NOT_MEMBER` otherwise), and guild changes (leave, kick, disband) move the
  player's live connections out of the channel as soon as they commit, so former members stop receiving lines at once.
  Lines carry a per-recipient `self` flag instead of user ids. Fanout events travel through the Colyseus presence
  (server side only). Tests: `test/service_guild_chat_test.ts`.
- Player reports (`report_player`): the reporter is the session user; the payload carries ids, never evidence. The
  reported line and the target's recent lines are read from the server's stored chat history (`chat_messages`,
  `guild_chat_messages`) and copied into `player_reports`, so a report cannot be forged or edited by the client. A line
  must belong to the named target, and a guild line is only reportable by a member of that guild (nobody pulls text out
  of a channel they cannot read). One open report per reporter → target is enforced by the transaction (reporter row
  lock) and by a unique index, so concurrent requests cannot duplicate or exceed the daily limit. Tests:
  `test/service_report_test.ts`.
- Social (`social` room): targets are user ids (already public in chat lines) or exact profile names, but every
  operation is authorized from the session user: a friend request id only resolves for its addressee (accept / reject)
  or its requester (cancel), `dm/history` reads the conversation key built from the session user and the peer (a third
  player only ever sees their own conversation with that peer), private messages need a friendship (or a shared guild
  when configured) and no block either way, and a private line is only reportable by its recipient. Public profiles
  expose name, icon, level, guild name, arena rating and friend count, never the account name or email. Blocks are
  deliberately one-sided in the answers (`FRIEND_REQUEST_REFUSED` / `DM_NOT_ALLOWED` / `FRIENDLY_NOT_ALLOWED` never say
  "you were blocked"). Tests: `test/service_friends_test.ts`, `test/service_dm_test.ts`.
- Friendly battles: only the challenged player accepts, only the challenger cancels. The `battle_pvp` room can only be
  created by the server (HMAC of the match id with `JWT_ACCESS_SECRET`, `pvp-ticket.ts`), only the two players of the
  match may join (one connection each), commands are accepted only from the player whose unit must act, teams are
  validated against the player's own roster, and each frame strips the opponent's roster / rune uids and action
  options. Tests: `test/service_friendly_test.ts`, `test/battle_pvp_room_test.ts`.
- One live battle per player (`src/shared/rooms/active-battles.ts`): starting a battle in another room or device while
  one runs answers `BATTLE_IN_PROGRESS`; a battle room keeps a dropped player's seat for a short window and only that
  player can reconnect into it (Colyseus reconnection token). Tests: `test/active_battles_test.ts`,
  `test/battle_room_reconnect_test.ts`.
- Covered by `test/e2e/full-flow.e2e.ts` ("refuses ... other players' units") and by the service
  unit tests (`test/service_*_test.ts`).

## Broken function level authorization (BFLA)
- `/admin/runtime/*` and `/admin/config/*` require the `x-config-api-key` header (header only: a key in the query string,
  `Authorization` or a cookie is ignored), compared in constant time. When `CONFIG_API_KEY` is empty the admin API answers 404.
  The check runs in front of everything else (`modules/admin/admin-guard.ts`): optional address allowlist, failed-key
  lockout, then the key, all **before any request body is read or parsed**. See "Admin API and GM panel hardening".
  The GM panel page (`/gm`) carries no data and no key; the panel keeps the key in the browser only.
- GM player actions (`/admin/runtime/players/:player/*`: kick, ban, chat mute, set currency / level, story reset) sit
  behind the same key, resolve the target server-side, validate with strict zod schemas and write both the admin
  trail and the player's own trail (`GM_*`, `BAN`, `UNBAN`). Balances are set inside a wallet transaction through the
  ledger (caps respected), never by raw SQL. The panel renders every player-provided string escaped.
- The other GM panel writes (rename, mail, unit / rune edits and deletes, guild kick / transfer / disband / edit,
  guild removal, device sign-out, chat line delete, broadcast revoke) follow the same rules: key-gated, strict schemas,
  audited (`GM_*`), and routed through the domain repositories / services (equipped runes are released before a delete,
  guild rules and notices are the player-facing ones). The list / analytics / audit views only read; analytics and
  the global audit log use parameterized queries over existing tables. The panel is one offline page (no third-party
  requests) and keeps the key only in `localStorage`; serve `/gm` behind TLS in production.
- Developer-only room actions (`runes/grant`) answer `FORBIDDEN` unless `DEV_TOOLS=true`; the server
  refuses to boot with `DEV_TOOLS=true` in production.
- There is no client-callable "add currency", "grant rune" or "report stage clear": currencies,
  runes, EXP and clears are granted by the battle room (server-side battle) and the shop.
- `/monitor` is only mounted outside production, and even then behind the admin guard (address allowlist, lockout, HTTP
  Basic auth with the admin key as password; not mounted at all without a key); the playground and the OpenAPI reference
  are not mounted.

## Input validation / mass assignment
- Every request payload is parsed with a zod `.strict()` schema (`src/modules/*/*.validation.ts`):
  unknown keys are rejected, strings are trimmed with max lengths, arrays and numbers are bounded.
- Repositories write explicit column lists; raw payloads are never spread into database writes.
- WebSocket frames are limited to `WS_MAX_PAYLOAD_BYTES` (64 KB). HTTP bodies are limited to `HTTP_MAX_BODY_BYTES`
  (64 KB) on every route, **including the `/matchmake` endpoints** (Colyseus buffers those bodies without a limit): the
  size guard in `installRequestGuard` answers `413` from the `Content-Length` before Colyseus or Express see the body, and
  `411` for a chunked matchmaking body without a length. The admin config import accepts up to 10 MB JSON / 50 MB zip
  (`/admin/config/import` only, after the key check).

## Authentication
- `logout` proves ownership of the device with its refresh token: user ids are visible to other players (chat lines), so a
  logout whose (user, device, token) does not match revokes nothing, publishes nothing and writes no audit/token log row
  (the answer is the same `ok` either way). Access tokens must carry `exp` (a correctly signed token without it is refused).
- Passwords: Argon2id + server pepper. Refresh tokens: random 48 bytes, stored as SHA-256 + pepper,
  rotated on every refresh, revocable on logout.
- Access tokens: JWT HS256 only, with fixed issuer/audience and expiry (`ACCESS_TTL_MIN`). The
  token id (`jti`) must match the active session stored in Redis, so logout, bans and refresh
  rotation revoke older tokens immediately. Rooms re-check the session every 5 s, and every revocation (logout,
  logout of other devices, password change, deletion request, GM kick / sign-out / ban) is published on the Colyseus
  presence bus (`auth:user_revoked`): each authenticated room closes the connections of that player whose session is
  gone with 4401 at once (the caller's own device keeps its connections), so a revoked session can't keep receiving
  chat lines or other pushes.
- Login answers the same `AUTH_INVALID_CREDENTIALS` for unknown users and wrong passwords and
  performs a dummy hash check for unknown users (no timing oracle). Six failures lock the account
  for 30 s; the failed-login counter is committed even though the request fails.
- Rooms authenticate at matchmaking time (static `onAuth`), so invalid tokens can't create rooms.
- Guests (`users.is_guest = 1`, email `guest+<id>@local`, random password nobody knows) can turn into registered
  accounts with `account` → `link_email` (same Argon2id + pepper as register; the email must not match any other
  account's email or username, since login accepts either). Their current session and refresh token stay valid.
- Password checks outside login (`change_password`, `request_deletion`, `auth` → `cancel_deletion`) go through the
  same guard as login: a locked account answers `AUTH_ACCOUNT_LOCKED`, and every wrong password increments the
  same `failed_logins` counter (committed even though the request fails), so the account room can't be used to
  brute-force around the login lock. These requests also have their own per-user limiter (5 / 30 s).
- Revocation rules:
  - `logout`: that device's refresh token + session.
  - `change_password` / `logout_other_devices`: refresh tokens (marked revoked, logged as `REVOKE`) and Redis
    sessions of every device except the caller's (device id taken from the access token claims, never the payload).
  - `request_deletion` and bans: every refresh token and every session of the account. For deletion the sessions are
    deleted just after the reply is sent, so the caller still receives the confirmation.
- Account deletion lifecycle (the requests are in [`PROTOCOL.md`](PROTOCOL.md), room `account`): `request_deletion`
  stores `deletion_requested_at` / `deletion_scheduled_at` (= request + `ACCOUNT_DELETION_GRACE_DAYS`, default 30)
  and revokes everything. While pending, `login` (only after a correct password) and `refresh` answer
  `ACCOUNT_DELETION_PENDING`; `auth` → `cancel_deletion` (verified like login) clears the schedule. The daily
  `AccountPurgeJob` (also run once at boot) hard-deletes accounts past their date: player data goes through the
  `ON DELETE CASCADE` foreign keys, `user_refresh_token_log` rows are deleted explicitly, older `audit_events` keep
  their rows with `user_id` set to NULL, and one `ACCOUNT_PURGED` audit row is written with `user_id` NULL and only
  `sha256(userId)` as metadata. Audit kinds: `LINK_EMAIL`, `PASSWORD_CHANGE`, `LOGOUT_OTHERS`, `DELETION_REQUESTED`,
  `DELETION_CANCELLED`, `ACCOUNT_PURGED`.

## Client address (IP) and proxies
- Colyseus resolves the client address from `x-real-ip`, `x-forwarded-for` or `x-client-ip` before the socket
  address, so any client could choose its own address (and dodge the per-IP limits) by sending one of those
  headers. The rooms therefore use **the socket's remote address only** (`src/shared/rooms/client-address.ts`).
- Behind a reverse proxy / load balancer set `TRUST_PROXY=true`: the forwarded address is then used. Set
  `TRUSTED_PROXIES` (comma separated peer addresses of the proxies, e.g. `10.0.0.2,::1`) so that only connections
  coming from those peers may set the header; with an empty list every peer is trusted, which is only safe when the
  proxy is the only way to reach the server. Without `TRUST_PROXY` behind a proxy, all clients share the proxy's
  address and the per-IP limits (auth 10 / 10 s, requests 200 / 10 s) would throttle everybody.
- Express (`req.ip`, used by the admin audit trail) follows the same setting: `app.set("trust proxy", ...)` is `false`
  without `TRUST_PROXY`, the `TRUSTED_PROXIES` list with it (empty list = every hop), see `expressTrustProxySetting`.
- The address is only a coarse limiter and audit field; the per-user limits and chat moderation stay the primary
  protection.

## Logs and retried requests
- Server logs go to the GM panel (Logs) and the `server_logs` table, not to the terminal (`LOG_CONSOLE=none` by default;
  `error` / `all` print to the terminal as well). Messages are redacted (JWT-like tokens, `password` / `token` /
  `secret` / `authorization` fields) before they are stored; never log secrets on purpose. Retention: `LOG_RETENTION_DAYS`
  (14). The panel needs the admin key like every `/admin/runtime` route.
- Idempotent requests (`requestId`, see "Conventions" in [`PROTOCOL.md`](PROTOCOL.md)): the stored response is scoped by
  the authenticated user (a request id of another player is invisible), is written in the mutation's transaction and
  is purged after `REQUEST_RESULT_RETENTION_DAYS` (7).

## Rate limiting
- Per IP: credential attempts (10 / 10 s), every authenticated request (200 / 10 s).
- Per user: queries (60 / 10 s), mutations (30 / 10 s), battle steps (40 / 10 s), account management
  (5 / 30 s), chat (config). Guild chat `send` uses the same chat moderation (`ChatService.moderate`: per-IP bucket,
  per-user window, word filter, duplicate mutes; mutes apply to every channel) and `history` the query limiter.
  `report_player` uses the account bucket (5 / 30 s) plus a per-player cooldown and rolling 24 h limit (config).
  Global chat `history` uses the query limiter; guild chat `send` has its own per-user bucket (8 / 10 s, burst 12)
  in front of the moderation; presence heartbeats closer than 2 s per connection are ignored.
- The limits live in the memory of each process by default. With several processes behind a load balancer set
  `RATE_LIMIT_STORE=redis` (the default in production) so that they share the buckets.
- Seat reservations (room joins) are limited per account: 30 / 10 s, burst 90 (`limiters.join`, checked in
  `AuthenticatedRoom.onAuth`; a client opens ~21 rooms at login, two devices ~42). Over the limit the matchmaking call
  answers `429 RATE_LIMIT`.
- **Connections per account** (`src/shared/rooms/connection-limits.ts`, hooked in `bindRoom`): at most
  `MAX_CONNECTIONS_PER_USER` (default 64) simultaneous room connections across every room and
  `MAX_CONNECTIONS_PER_USER_PER_ROOM` (default 8) to the same room type (so at most 8 `battle_pve` rooms), `0` = off.
  A normal client keeps one connection per room type (~21) and may be signed in on two devices (~42), so the defaults
  leave room for reconnects the server has not noticed yet. The connection over the cap is refused in `onJoin`
  (`TOO_MANY_CONNECTIONS`, code 429) before the room's own handler runs, and the slot is freed when the socket closes.
  The counters are per process (with several processes behind a load balancer the effective cap is multiplied; sticky
  routing per user, or lower values, keeps it tight). Guest accounts are free, so this cap and the per-IP limits are
  defence in depth; the proxy / firewall remains responsible for connection floods per address.

## Race conditions / double spend
- Every currency or inventory mutation runs in one database transaction that locks the touched
  rows (`SELECT ... FOR UPDATE`) before checking balances/limits.
- Battle rewards are idempotent per `battle_id` (`pve_battles` status transition under lock).
- Shop purchases accept a client `purchaseId`; retries with the same id replay the first answer.
- Real-money purchases (docs/IAP.md): the store receipt is verified server side (Google Android Publisher API, Apple
  StoreKit 2 signature chain pinned to Apple Root CA - G3 + marker extensions + bundle id), never trusted from the
  client. Each store transaction is delivered once across all accounts (`user_iap_transactions` primary key, kept after
  account deletion); an account token derived from the user id (Apple `appAccountToken`, Google
  `obfuscatedAccountId`) must match when present. Demo receipts need the exported toggle AND, in production,
  `IAP_DEMO_PURCHASES=true`. Store credentials (Google service account) live only in the server `.env`.
- Stage tickets (energy already paid) are consumed by exactly one `battle_start`.
- Arena: the Arena Wing is spent in the transaction that records the battle (`arena_battles`); rating changes and
  rewards are applied once per battle id (`rewards_granted` under a row lock, both profiles locked in id order);
  `battle_start_arena` only accepts opponents in the player's current offered list, and `u:<publicId>` handles never
  expose internal user ids, uids or rune details (defender metadata is stripped from the battle state).
- Arena seasons: no request triggers a grant. Season rewards are computed from the stored rating and mailed by the
  server once per player and season (conditional update on `arena_profiles.season` under the row lock + mail receipt
  key `arena_season:<n>`); the client only claims the mail. Every settlement is audited (`ARENA_SEASON`).

## Errors, logging and audit
- Clients only receive error codes (`{ ok: false, error }`); unexpected exceptions become
  `SERVER_ERROR` and are logged server-side.
- `audit_events` records logins, registrations, refreshes, logouts, bans, account changes (email link,
  password change, device logout, deletion request/cancel/purge), shop purchases, stage
  rewards, GM grants, GM moderation (kick, ban, mute, set currency / level, story reset, report decisions
  `GM_REPORT_RESOLVE` / `GM_REPORT_DISMISS` with the report ids, action and note) and every admin POST. Old rows are
  archived by the retention job.
- The chat word filter keeps no text: per-player masked / blocked counters live in memory only (GM panel), and the
  panel's "Test filter" is a GET that is neither stored nor counted. Report decisions are claimed with
  `WHERE status = 'open'`, so a double click or two moderators never apply a sanction twice.

## Secrets, HTTP and configuration
- `NODE_ENV=production` refuses missing, placeholder (starting with `change-me`, `replace-me`, `super-secret` or `dev-`,
  or exactly `secret` or `password`) and short (< 16 characters) secrets. In development the first `npm start` writes
  `.env` with random secrets.
- HTTP responses (API, panel, 404, matchmaking) carry `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy`, `Cross-Origin-Opener-Policy`, `Permissions-Policy` and a
  `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` (the panel page replaces it with its own policy);
  `Strict-Transport-Security` is added when the request came over TLS; `x-powered-by` is disabled.
- `TRUST_PROXY` / `TRUSTED_PROXIES`: see "Client address (IP) and proxies".
- CORS is closed by default: no `Access-Control-Allow-Origin` and never `Allow-Credentials`. `CORS_ORIGINS` (comma
  separated) opens the HTTP API and matchmaking to those exact origins (WebGL builds). Colyseus itself answers `*` / the
  caller's own origin with credentials on every request unless its defaults are replaced; `configureMatchmakingCors`
  replaces them and `restrictedCors` strips what is left on Express routes. Native clients don't need CORS.
- Error answers are JSON only (`{ ok: false, error }`): malformed JSON is `INVALID_JSON`, unknown routes `NOT_FOUND`,
  anything unexpected `SERVER_ERROR`. Express' default HTML error page (stack trace and file paths) is replaced by
  `jsonErrorHandler`. A matchmaking error whose code is not a valid HTTP status (a room that throws a 4xxx close code)
  is answered `400` with the code in the message instead of failing the reply (`guardMatchmakeErrorCodes`).

## Admin API and GM panel hardening
- **Address allowlist** (`ADMIN_ALLOWED_IPS`, optional): comma-separated IPv4 / IPv6 addresses or CIDR ranges
  (`10.0.0.0/8,2001:db8::/32`; `localhost` = `127.0.0.1` and `::1`). When set, every other address gets `404` on `/admin/*`,
  `/gm` and `/monitor`, before the key is even looked at. A malformed entry stops the boot (fail closed). The address is
  `req.ip`, resolved by `TRUST_PROXY` / `TRUSTED_PROXIES` exactly like the rooms (see "Client address (IP) and proxies"):
  behind a reverse proxy set both, or every request looks like the proxy. Empty = any address (the key is still required).
- **Failed-key lockout**: `ADMIN_MAX_FAILED_ATTEMPTS` (10) wrong or missing keys from one address inside
  `ADMIN_LOCKOUT_SECONDS` (300) lock that address out for the same time: `429 { error: "ADMIN_LOCKED" }` with
  `Retry-After`, **even for the right key** (a guesser never learns whether a guess was right). A correct key clears the
  counter. IPv6 clients are counted by their /64. The counter is shared by `/admin/*` and `/monitor`, lives in the process
  memory (one counter per process behind a load balancer) and is capped at 10 000 tracked addresses. A lockout is logged
  once (address only, never the attempted key).
- **No pre-auth parsing**: the guard runs before `express.json`, so an unauthenticated caller can neither make the server
  parse a 10 MB body nor trigger a body-parser error page.
- **Config import** (`modules/admin/admin-config.routes.ts`): JSON must be `application/json` and an object; a zip is
  inspected before anything is extracted (at most 400 entries, 64 MB per entry and 256 MB in total by their declared sizes,
  which adm-zip enforces while inflating, no `..` / absolute / drive / NUL names, no symbolic links) and read with a hard
  byte limit that answers `413`. Every import is audited (`ADMIN_CONFIG_IMPORT`). Failure answers carry validation issues
  and our own messages only, never file paths or driver text.
- **GM panel page**: served with `Content-Security-Policy: default-src 'none'; script-src 'nonce-<random per response>';
  style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none';
  frame-ancestors 'none'; object-src 'none'` and `Cache-Control: no-store`. The page has one inline script (the nonce), no
  inline event handlers, no external resource and no `eval`, so an injected tag cannot run code even if an escape were
  missed. Every dynamic string is escaped by `esc()` before it is concatenated into markup (`gm-panel/script-core.ts`);
  only numbers from the server (ids, counters) are written as they are, and toasts use `textContent`.
- **Stored XSS review**: nicknames accept any character (`canUseSpecialChar`), chat lines, report comments, guild texts,
  device ids and usernames are free text, and GM reasons end up in the audit trail. They all reach the panel as JSON
  (`application/json`, `nosniff`) and are escaped when rendered. Checked three ways: the unit test
  `test/fix_http_panel_xss_test.ts` (a break-out payload in every free-text field, every view and dialog on a DOM stub; a
  deliberately broken write proves the check can fail), the pentest `admin-xss` (real players, guild, reports, mail and
  sanctions with markup, rendered in a headless browser, with a positive control) and a review of the panel scripts.
- **Not covered / accepted**: the lockout is per address, so a distributed guess (many addresses) is limited only by the
  strength of the key (production refuses keys shorter than 16 characters or default placeholders: use 32+ random
  characters) and by `ADMIN_ALLOWED_IPS`; the lockout also locks out the real operator behind the same address (NAT) for
  `ADMIN_LOCKOUT_SECONDS`; the key lives in the browser's `localStorage` (any XSS in the panel would read it, hence the CSP);
  serve `/gm` and `/admin` over TLS and, ideally, only from a VPN / allowlisted network; the in-memory counters reset on a
  restart; Colyseus' `/__healthcheck` and the matchmaking endpoints are public by design (`/health` exposes only `ok`,
  `maintenance`, `uptime`, `serverTime`).
- Tests: `test/fix_http_admin_guard_test.ts`, `fix_http_hardening_test.ts`, `fix_http_config_bundle_test.ts`,
  `fix_http_panel_xss_test.ts`; black-box: `npm run pentest:http` (`tools/pentest/README.md`).

## Checklist for new features
1. Validate the payload with a `strictPayload({...})` schema with bounded fields.
2. Take the user id from the request context; scope every query by `user_id`.
3. Do the read-check-write inside `uow.transaction()` and lock rows with `.for("update")`.
4. Never accept amounts/prices/rewards from the client; derive them from config.
5. Rate-limit the request (`rateLimit: deps.mutationLimiter`) and record economy changes in the
   audit log.
