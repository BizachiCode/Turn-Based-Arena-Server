// Express routes mounted next to the Colyseus transport: health, admin API, GM panel, monitor (dev).
// Also the HTTP hardening shared with the matchmaking endpoints: security headers, CORS, request size guard, JSON errors.

import crypto from "node:crypto";
import type http from "node:http";
import type express from "express";
import expressLib from "express";
import { matchMaker, ServerError } from "@colyseus/core";
import { monitor } from "@colyseus/monitor";

import { createAdminConfigRouter } from "../modules/admin/admin-config.routes.js";
import { createAdminGuard } from "../modules/admin/admin-guard.js";
import { gmPanelCsp, renderGmPanelPage } from "../modules/admin/gm-panel.page.js";
import { createRuntimeAdminRouter } from "../modules/admin/runtime-admin.routes.js";
import { createLogger } from "../shared/logger.js";
import { expressTrustProxySetting } from "../shared/rooms/client-address.js";
import type { AppContainer } from "./container.js";

const logger = createLogger("Http");

/** Headers every response carries (API answers, the panel page, matchmaking replies). */
const BASELINE_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  // JSON answers never need to load anything; the GM panel page replaces this with its own policy.
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

const HSTS = "max-age=15552000";

function applyBaselineHeaders(res: http.ServerResponse): void {
  for (const [name, value] of Object.entries(BASELINE_HEADERS)) res.setHeader(name, value);
}

/** Security headers for every Express response (HSTS only when the request really came over TLS). */
export function securityHeaders(): express.RequestHandler {
  return (req, res, next) => {
    applyBaselineHeaders(res);
    if (req.secure) res.setHeader("Strict-Transport-Security", HSTS);
    next();
  };
}

const CORS_HEADER_PREFIX = "access-control-";

/**
 * CORS restricted to the configured origins. Colyseus adds its own CORS headers to every request before Express runs,
 * so those are removed first: an origin that is not listed gets no `Access-Control-*` header at all.
 */
export function restrictedCors(allowedOrigins: readonly string[]): express.RequestHandler {
  return (req, res, next) => {
    for (const name of res.getHeaderNames()) {
      if (name.startsWith(CORS_HEADER_PREFIX)) res.removeHeader(name);
    }
    const origin = req.header("origin");
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "content-type");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    }
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  };
}

type CorsController = {
  DEFAULT_CORS_HEADERS: Record<string, string>;
  getCorsHeaders: (headers: Headers) => Record<string, string>;
};

/**
 * CORS of the matchmaking endpoints (`/matchmake/*`). Colyseus' defaults answer `Access-Control-Allow-Origin: *` (or the
 * caller's own Origin) together with `Allow-Credentials: true`, which opens the API to every web page. Only the
 * `CORS_ORIGINS` list gets an `Access-Control-Allow-Origin`; native clients send no Origin and need none.
 */
export function configureMatchmakingCors(allowedOrigins: readonly string[], controller: CorsController = matchMaker.controller as unknown as CorsController): void {
  controller.DEFAULT_CORS_HEADERS = {
    "Access-Control-Allow-Headers": "Origin, X-Requested-With, Content-Type, Accept, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "600",
  };
  controller.getCorsHeaders = (headers: Headers) => {
    const origin = headers.get("origin");
    return origin && allowedOrigins.includes(origin) ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {};
  };
}

export type RequestGuardOptions = {
  /** Largest request body (Content-Length) for every route. */
  maxBodyBytes: number;
  /** Larger limits for specific path prefixes (the config bundle upload). */
  largerLimits?: ReadonlyArray<{ prefix: string; maxBytes: number }>;
  /** Slowloris protection: how long a client may take to send its headers / the whole request (ms). */
  headersTimeoutMs?: number;
  requestTimeoutMs?: number;
};

const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Wraps the HTTP server's `request` event, so it runs before Colyseus' own listener (the matchmaking endpoints read the
 * whole body into memory with no limit). Oversized or length-less bodies are answered 413 / 411 here and never reach
 * Colyseus or Express; the baseline security headers are also set on the matchmaking replies this way.
 */
export function installRequestGuard(server: http.Server, options: RequestGuardOptions): void {
  const { maxBodyBytes, largerLimits = [] } = options;
  if (options.headersTimeoutMs) server.headersTimeout = options.headersTimeoutMs;
  if (options.requestTimeoutMs) server.requestTimeout = options.requestTimeoutMs;

  const originalEmit = server.emit.bind(server) as (event: string | symbol, ...args: unknown[]) => boolean;
  const reject = (res: http.ServerResponse, status: number, error: string) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Connection", "close");
    res.end(JSON.stringify({ ok: false, error }));
  };

  (server as unknown as { emit: typeof originalEmit }).emit = (event, ...args) => {
    if (event !== "request") return originalEmit(event, ...args);
    const [req, res] = args as [http.IncomingMessage, http.ServerResponse];
    applyBaselineHeaders(res);

    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const limit = largerLimits.find((rule) => path.startsWith(rule.prefix))?.maxBytes ?? maxBodyBytes;
    const declared = req.headers["content-length"];
    if (declared !== undefined && Number(declared) > limit) {
      reject(res, 413, "PAYLOAD_TOO_LARGE");
      return true;
    }
    // Without a length the matchmaking handler would buffer an unbounded chunked stream.
    const chunked = String(req.headers["transfer-encoding"] ?? "").toLowerCase().includes("chunked");
    if (chunked && declared === undefined && BODY_METHODS.has(req.method ?? "") && path.startsWith("/matchmake")) {
      reject(res, 411, "LENGTH_REQUIRED");
      return true;
    }
    return originalEmit(event, ...args);
  };
}

/** Unknown route: the same JSON shape as every other error (no framework HTML page). */
export const jsonNotFound: express.RequestHandler = (_req, res) => {
  res.status(404).json({ ok: false, error: "NOT_FOUND" });
};

type HttpError = Error & { status?: number; statusCode?: number; type?: string };

/** Last error handler: JSON only, never a stack trace, file path or driver message. */
export const jsonErrorHandler: express.ErrorRequestHandler = (error: HttpError, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  const status = Number(error?.status ?? error?.statusCode);
  if (error?.type === "entity.too.large" || status === 413) {
    res.status(413).json({ ok: false, error: "PAYLOAD_TOO_LARGE" });
    return;
  }
  if (error?.type === "entity.parse.failed" || error instanceof SyntaxError) {
    res.status(400).json({ ok: false, error: "INVALID_JSON" });
    return;
  }
  if (error?.type === "encoding.unsupported" || error?.type === "charset.unsupported" || status === 415) {
    res.status(415).json({ ok: false, error: "UNSUPPORTED_MEDIA_TYPE" });
    return;
  }
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    res.status(status).json({ ok: false, error: "BAD_REQUEST" });
    return;
  }
  logger.error("unhandled http error:", error);
  res.status(500).json({ ok: false, error: "SERVER_ERROR" });
};

export function configureHttp(app: express.Application, container: AppContainer): void {
  const { config, runtime, services } = container;

  app.disable("x-powered-by");
  // `req.ip` (admin guard, audit trail) follows the same TRUST_PROXY / TRUSTED_PROXIES setting as the rooms.
  app.set("trust proxy", expressTrustProxySetting({ trustProxy: config.trustProxy, trustedProxies: config.trustedProxies }));
  app.use(securityHeaders());
  app.use(restrictedCors(config.corsOrigins));

  if (config.adminAllowedIps.length > 0 && config.trustProxy && config.trustedProxies.length === 0) {
    // With every hop trusted, a client can send its own X-Forwarded-For and look like an allowlisted (or a fresh) address.
    logger.warn("ADMIN_ALLOWED_IPS is set while TRUST_PROXY=true and TRUSTED_PROXIES is empty: clients can forge X-Forwarded-For. List the proxy addresses in TRUSTED_PROXIES, and let only the proxy reach this port.");
  }

  const guard = createAdminGuard({
    apiKey: config.configApiKey,
    allowedIps: config.adminAllowedIps,
    maxFailures: config.adminMaxFailedAttempts,
    lockoutSeconds: config.adminLockoutSeconds,
  });

  // The monitor shows rooms and sessions: dev only, behind the allowlist, the lockout and the admin key (HTTP Basic).
  if (!config.isProd && config.configApiKey) {
    app.use("/monitor", guard.allowlist, guard.requireBasicAuth, monitor());
  }

  // The panel page itself holds no data (the key stays in the browser); a browser cannot send the key header on a page load.
  if (config.configApiKey) {
    app.get(["/gm", "/admin/gm"], guard.allowlist, (_req, res) => {
      const nonce = crypto.randomBytes(16).toString("base64");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Security-Policy", gmPanelCsp(nonce));
      res.type("html").send(renderGmPanelPage(nonce));
    });
  }

  // Everything else under /admin: address allowlist, lockout and key BEFORE any body is read or parsed.
  app.use("/admin", (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); }, guard.allowlist, guard.requireKey);

  app.use("/admin/config", createAdminConfigRouter({ service: services.catalogs, apiKey: config.configApiKey, audit: container.audit }));
  app.use("/admin/runtime", expressLib.json({ limit: config.httpMaxBodyBytes }), createRuntimeAdminRouter({ apiKey: config.configApiKey, runtime, grants: services.grants, mail: services.mail, audit: container.audit, players: services.adminPlayers,
    edits: services.adminEdits, analytics: services.adminAnalytics, guilds: services.adminGuilds, moderation: services.adminModeration, config: services.adminConfig, reports: services.adminReports, logs: services.adminLogs }));

  app.get("/health", (_req, res) => {
    const payload = runtime.getHealthPayload();
    res.status(payload.ok ? 200 : 503).json(payload);
  });

  app.get("/hello_world", (_req, res) => res.send("TurnArena server OK"));

  app.use(jsonNotFound);
  app.use(jsonErrorHandler);
}

type InvokeController = { invokeMethod: (...args: any[]) => Promise<unknown> };

/**
 * Colyseus answers matchmaking failures with its own 52x codes (520 no handler, 521 invalid criteria, 522 invalid room
 * id, 523 unhandled, 524 seat expired, 525 onAuth failed). Cloudflare replaces every 52x answer of the origin with its
 * own error page, which has no CORS header: a WebGL client then saw a "CORS" failure instead of "onAuth failed", and
 * could not renew its expired access token and retry. These codes are sent as regular HTTP statuses (525 -> 401, the
 * status the clients already treat as "renew the token and join again"); the original code stays in the message.
 */
const PROXY_SAFE_MATCHMAKE_STATUS: Readonly<Record<number, number>> = { 520: 404, 521: 400, 522: 404, 523: 400, 524: 410, 525: 401 };

/**
 * Matchmaking errors travel as the HTTP status of the answer (`ctx.error(error.code)`): a room that throws a
 * `ServerError` with a close code (4xxx) or any other number outside 100-599 made the reply itself fail with a
 * RangeError (invalid status code). Such codes are answered 400 with the original code in the message.
 */
export function guardMatchmakeErrorCodes(controller: InvokeController = matchMaker.controller as unknown as InvokeController): void {
  const original = controller.invokeMethod.bind(controller);
  controller.invokeMethod = async (...args: unknown[]) => {
    try {
      return await original(...args);
    } catch (error) {
      const code = Number((error as { code?: unknown })?.code);
      const proxied = PROXY_SAFE_MATCHMAKE_STATUS[code];
      if (proxied) {
        const message = error instanceof Error ? error.message : "matchmaking failed";
        throw new ServerError(proxied, `${message} (code ${code})`);
      }
      if (Number.isInteger(code) && code >= 100 && code <= 599) throw error;
      const message = error instanceof Error ? error.message : "matchmaking failed";
      throw new ServerError(400, `${message} (code ${String((error as { code?: unknown })?.code ?? "unknown")})`);
    }
  };
}
