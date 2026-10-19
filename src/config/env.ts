// src/config/env.ts
// Typed environment variables — single source of truth.
// Production refuses to boot with missing/default secrets or with developer tools enabled.

import * as dotenv from "dotenv";
dotenv.config({ quiet: true });

import { parseLogConsoleMode } from "../shared/log/log-types.js";

const nodeEnv = process.env.NODE_ENV || "development";
const isProd = nodeEnv === "production";
const isTest = nodeEnv === "test";

/** Values that must never reach production (shipped defaults / documentation placeholders). */
const INSECURE_SECRET_PATTERNS: RegExp[] = [
  /^change-me/i,
  /^replace-me/i,
  /^super-secret/i,
  /^dev-/i,
  /^secret$/i,
  /^password$/i,
];

const MIN_PRODUCTION_SECRET_LENGTH = 16;

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

function optionalInt(key: string, fallback: number): number {
  const raw = process.env[key];
  const value = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(value) ? value : fallback;
}

function optionalBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function isInsecureSecret(value: string): boolean {
  return INSECURE_SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Reads a secret. In development a fallback is accepted (with a warning); in production the value
 * must be set, must not be a known default and must be at least 16 characters long.
 */
function secret(key: string, devFallback: string): string {
  const value = process.env[key];

  if (isProd) {
    if (!value) throw new Error(`[env] Missing required secret ${key} (production).`);
    if (isInsecureSecret(value)) throw new Error(`[env] ${key} uses a default/placeholder value; set a real secret before booting in production.`);
    if (value.length < MIN_PRODUCTION_SECRET_LENGTH) throw new Error(`[env] ${key} must be at least ${MIN_PRODUCTION_SECRET_LENGTH} characters in production.`);
    return value;
  }

  if (!value || isInsecureSecret(value)) {
    if (!isTest) console.warn(`[env] ${key} is using an insecure development value.`);
  }

  return value || devFallback;
}

/** Optional secret: empty when unset (feature disabled); when set it must be a real secret in production. */
function optionalSecret(key: string): string {
  const value = process.env[key] || "";
  if (!value) {
    if (!isTest) console.warn(`[env] ${key} is not set: the related feature is disabled.`);
    return "";
  }
  if (isProd && (isInsecureSecret(value) || value.length < MIN_PRODUCTION_SECRET_LENGTH)) {
    throw new Error(`[env] ${key} uses a default/short value; set a real secret (>= ${MIN_PRODUCTION_SECRET_LENGTH} chars) or leave it empty to disable the admin API.`);
  }
  if (!isProd && isInsecureSecret(value) && !isTest) console.warn(`[env] ${key} is using an insecure development value.`);
  return value;
}

function resolveDevTools(): boolean {
  const requested = optionalBool("DEV_TOOLS", false);
  if (requested && isProd) {
    throw new Error("[env] DEV_TOOLS=true is not allowed when NODE_ENV=production.");
  }
  return requested;
}

export const env = {
  nodeEnv,
  isProd,
  isTest,
  port: optionalInt("PORT", 2567),
  logLevel: optional("LOG_LEVEL", "info"),
  /** What the terminal prints: none (default; logs are read in the GM panel), error, or all. */
  logConsole: parseLogConsoleMode(process.env.LOG_CONSOLE),
  /** Days the `server_logs` rows are kept (GM panel Logs). */
  logRetentionDays: optionalInt("LOG_RETENTION_DAYS", 14),
  /** Days the stored responses of idempotent requests (`user_request_results`) are kept. */
  requestResultRetentionDays: optionalInt("REQUEST_RESULT_RETENTION_DAYS", 7),

  /** Enables developer-only room actions (e.g. `runes/grant`). Never allowed in production. */
  devTools: resolveDevTools(),

  // JWT
  jwtAccessSecret: secret("JWT_ACCESS_SECRET", "change-me-access"),
  accessTtlMin: optionalInt("ACCESS_TTL_MIN", 10),

  // Passwords / refresh tokens
  passwordPepper: secret("PASSWORD_PEPPER", "change-me-pepper"),
  refreshPepper: secret("REFRESH_PEPPER", "change-me-refresh-pepper"),

  // MySQL / MariaDB
  mysql: {
    host: optional("MYSQL_HOST", "127.0.0.1"),
    port: optionalInt("MYSQL_PORT", 3306),
    user: optional("MYSQL_USER", "root"),
    password: optional("MYSQL_PASSWORD", ""),
    database: optional("MYSQL_DATABASE", "game_arena_db"),
    connectionLimit: optionalInt("MYSQL_POOL_SIZE", 12),
  },
  /** Rate limiter store: "memory" (one process) or "redis" (shared by every process; default in production). */
  rateLimitStore: (optional("RATE_LIMIT_STORE", isProd ? "redis" : "memory") === "redis" ? "redis" : "memory") as "memory" | "redis",
  /** Applies pending database migrations on boot (default: on outside production). */
  dbAutoMigrate: optionalBool("DB_AUTO_MIGRATE", !isProd),

  // Redis
  redis: {
    host: optional("REDIS_HOST", "127.0.0.1"),
    port: optionalInt("REDIS_PORT", 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    db: optionalInt("REDIS_DB", 0),
    keyPrefix: optional("REDIS_KEY_PREFIX", "arena:"),
  },

  // Refresh tokens / retention
  refreshTtlDays: optionalInt("REFRESH_TTL_DAYS", 14),
  retentionTokenDays: optionalInt("RETENTION_URTL_DAYS", 30),
  retentionAuditDays: optionalInt("RETENTION_AUDIT_DAYS", 90),
  logExportDir: optional("LOG_EXPORT_DIR", "./export"),

  // Accounts
  /** Days between `request_deletion` and the hard delete by the purge job (0 = purge right away). */
  accountDeletionGraceDays: Math.max(0, optionalInt("ACCOUNT_DELETION_GRACE_DAYS", 30)),


  // HTTP / transport
  /** Comma-separated origins allowed to call the HTTP API and matchmaking (WebGL builds). Empty = same origin only. */
  corsOrigins: optional("CORS_ORIGINS", "").split(",").map((origin) => origin.trim()).filter((origin) => origin.length > 0),
  /**
   * Simultaneous room connections of one account across all rooms (0 = unlimited). A client keeps ~21 rooms open and may
   * be signed in on 2 devices (~42), so the default leaves headroom for reconnects that the server has not noticed yet.
   */
  maxConnectionsPerUser: Math.max(0, optionalInt("MAX_CONNECTIONS_PER_USER", 64)),
  /** Simultaneous connections of one account to the same room type, e.g. battle_pve (0 = unlimited). */
  maxConnectionsPerUserPerRoom: Math.max(0, optionalInt("MAX_CONNECTIONS_PER_USER_PER_ROOM", 8)),
  /** Max WebSocket message size in bytes. */
  wsMaxPayloadBytes: optionalInt("WS_MAX_PAYLOAD_BYTES", 64 * 1024),
  /**
   * Client address source. false (default) = the socket's remote address only; the `x-real-ip` / `x-forwarded-for` /
   * `x-client-ip` headers are ignored because any client can send them. true = the server runs behind a reverse proxy /
   * load balancer that sets those headers, so the forwarded address is used (see `TRUSTED_PROXIES`).
   */
  trustProxy: optionalBool("TRUST_PROXY", false),
  /**
   * Comma-separated proxy addresses allowed to set the forwarded headers (only read with TRUST_PROXY=true). Empty =
   * every peer is trusted, which is only safe when the server is reachable through the proxy alone.
   */
  trustedProxies: optional("TRUSTED_PROXIES", "").split(",").map((address) => address.trim()).filter((address) => address.length > 0),

  /** Largest body accepted by the JSON routes and the matchmaking endpoints (the config bundle import has its own, larger limits). */
  httpMaxBodyBytes: Math.max(1024, optionalInt("HTTP_MAX_BODY_BYTES", 64 * 1024)),

  // Admin / config
  /** Admin API key (header `x-config-api-key`). Empty disables /admin/* and the GM panel. */
  configApiKey: optionalSecret("CONFIG_API_KEY"),
  configDir: optional("CONFIG_DIR", "./game_config"),
  /**
   * Optional allowlist for /admin/*, the GM panel and the dev monitor: comma-separated IPs or CIDR ranges (`localhost` =
   * 127.0.0.1 and ::1). Empty = any address (the admin key is still required). Follows TRUST_PROXY / TRUSTED_PROXIES.
   */
  adminAllowedIps: optional("ADMIN_ALLOWED_IPS", "").split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0),
  /** Wrong admin keys from one address inside ADMIN_LOCKOUT_SECONDS before that address is locked out (429) for the same time. */
  adminMaxFailedAttempts: Math.max(1, optionalInt("ADMIN_MAX_FAILED_ATTEMPTS", 10)),
  adminLockoutSeconds: Math.max(1, optionalInt("ADMIN_LOCKOUT_SECONDS", 300)),
  maintenanceMode: optionalBool("MAINTENANCE_MODE", false),

  // Real-money purchases (docs/IAP.md). Product ids, package name and bundle id come from the Unity export (shop.json).
  iap: {
    /**
     * Demo purchases (`shop.json` iap.demoPurchases) grant RealMoneyIAP items without payment. Outside production they
     * follow the export; in production they also need IAP_DEMO_PURCHASES=true (a demo server), false disables them.
     */
    demoPurchases: optionalBool("IAP_DEMO_PURCHASES", !isProd),
    /** Google Play service account key (JSON file path, or the JSON itself): Android Publisher API access. */
    googleServiceAccountFile: optional("GOOGLE_PLAY_SERVICE_ACCOUNT_FILE", ""),
    googleServiceAccountJson: process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON || "",
    /** Apple: checks certificate revocation (OCSP) online and verifies dates against the current time. */
    appleOnlineChecks: optionalBool("APPLE_IAP_ONLINE_CHECKS", true),
    /** Folder with Apple's root certificates (`*.cer`, DER) used to verify App Store signed transactions. */
    appleRootCertsDir: optional("APPLE_ROOT_CERTS_DIR", "./certs/apple"),
  },
} as const;

export type Env = typeof env;
