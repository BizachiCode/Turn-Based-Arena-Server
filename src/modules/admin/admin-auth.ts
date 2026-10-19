import crypto from "node:crypto";
import type express from "express";

/** Constant-time comparison of the admin API key (hashes first, so lengths don't leak). */
export function adminKeyMatches(provided: string, expected: string): boolean {
  if (!expected) return false;
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Express middleware requiring the `x-config-api-key` header. When no key is configured the admin
 * API is disabled entirely (404).
 */
export function requireAdminKey(apiKey: string): express.RequestHandler {
  return (req, res, next) => {
    if (!apiKey) {
      res.status(404).json({ ok: false, error: "ADMIN_DISABLED" });
      return;
    }
    if (!adminKeyMatches(req.header("x-config-api-key") || "", apiKey)) {
      res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
      return;
    }
    next();
  };
}
