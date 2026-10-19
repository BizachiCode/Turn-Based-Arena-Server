// Gate in front of everything administrative (/admin/*, the GM panel page, the dev monitor): optional address
// allowlist (ADMIN_ALLOWED_IPS) and a lockout for addresses that keep sending wrong admin keys.
//
// Order of checks: address allowlist -> lockout -> key. A locked address gets 429 even with the right key, so a
// brute-force attempt never learns whether a guess was right once the lockout started.

import net from "node:net";
import type express from "express";

import { createLogger } from "../../shared/logger.js";
import { normalizeAddress } from "../../shared/rooms/client-address.js";
import { adminKeyMatches } from "./admin-auth.js";

const logger = createLogger("AdminGuard");

/** Longest failure table: a flood of spoofed/rotating addresses cannot grow it without bound. */
const MAX_TRACKED_ADDRESSES = 10_000;

export type AdminGuardOptions = {
  /** Admin API key; empty = the admin API is disabled (404). */
  apiKey: string;
  /** IPs / CIDR ranges allowed to reach the admin routes; empty = any address. */
  allowedIps: readonly string[];
  /** Wrong keys tolerated inside the window before the lockout. */
  maxFailures: number;
  /** Rolling window for counting failures and duration of the lockout. */
  lockoutSeconds: number;
  /** Clock (ms) for tests. */
  now?: () => number;
};

/** Parsed `ADMIN_ALLOWED_IPS`: exact addresses and CIDR ranges, IPv4 and IPv6 (`localhost` = 127.0.0.1 + ::1). */
export class AddressAllowList {
  private readonly list = new net.BlockList();
  readonly size: number;

  constructor(entries: readonly string[]) {
    let count = 0;
    for (const raw of entries) {
      const entry = raw.trim();
      if (!entry) continue;
      count += this.add(entry);
    }
    this.size = count;
  }

  private add(entry: string): number {
    if (entry.toLowerCase() === "localhost") {
      this.list.addAddress("127.0.0.1", "ipv4");
      this.list.addAddress("::1", "ipv6");
      return 1;
    }
    const slash = entry.indexOf("/");
    const address = slash < 0 ? entry : entry.slice(0, slash);
    const family = net.isIPv4(address) ? "ipv4" : net.isIPv6(address) ? "ipv6" : null;
    if (!family) throw new Error(`[admin] ADMIN_ALLOWED_IPS: "${entry}" is not an IP address or CIDR range`);
    if (slash < 0) {
      this.list.addAddress(address, family);
      return 1;
    }
    const prefix = Number(entry.slice(slash + 1));
    const max = family === "ipv4" ? 32 : 128;
    if (!/^\d{1,3}$/.test(entry.slice(slash + 1)) || prefix < 0 || prefix > max) {
      throw new Error(`[admin] ADMIN_ALLOWED_IPS: "${entry}" has an invalid prefix length`);
    }
    this.list.addSubnet(address, prefix, family);
    return 1;
  }

  /** True when the address matches an entry; unknown / malformed addresses never match. */
  allows(address: string | null | undefined): boolean {
    const value = normalizeAddress(address);
    if (!value) return false;
    // An IPv6 zone id (fe80::1%eth0) is not part of the address.
    const bare = value.split("%")[0] ?? value;
    const family = net.isIPv4(bare) ? "ipv4" : net.isIPv6(bare) ? "ipv6" : null;
    return family ? this.list.check(bare, family) : false;
  }
}

type FailureRecord = { count: number; windowStart: number; lockedUntil: number };

/**
 * Failed-key bookkeeping per client address (in memory, per process). IPv6 clients are keyed by their /64 so rotating
 * inside one subnet does not reset the counter.
 */
export class AdminFailureTracker {
  private readonly records = new Map<string, FailureRecord>();
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(private readonly maxFailures: number, lockoutSeconds: number, now: () => number = Date.now) {
    this.windowMs = Math.max(1, lockoutSeconds) * 1000;
    this.now = now;
  }

  static keyOf(address: string | null | undefined): string {
    const value = normalizeAddress(address) ?? "unknown";
    if (!net.isIPv6(value.split("%")[0] ?? value)) return value;
    // First four groups of the expanded address = the /64.
    const groups = expandIpv6(value.split("%")[0] ?? value);
    return groups ? `${groups.slice(0, 4).join(":")}::/64` : value;
  }

  /** Seconds until the address may try again, or 0 when it is not locked out. */
  lockedFor(address: string | null | undefined): number {
    const record = this.records.get(AdminFailureTracker.keyOf(address));
    if (!record) return 0;
    const remaining = record.lockedUntil - this.now();
    return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
  }

  /** Records a wrong (or missing) key. Returns true when this failure started a lockout. */
  fail(address: string | null | undefined): boolean {
    const key = AdminFailureTracker.keyOf(address);
    const now = this.now();
    let record = this.records.get(key);
    if (!record || (record.lockedUntil <= now && now - record.windowStart > this.windowMs)) {
      record = { count: 0, windowStart: now, lockedUntil: 0 };
      this.records.set(key, record);
      if (this.records.size > MAX_TRACKED_ADDRESSES) this.prune(now);
    }
    if (record.lockedUntil > now) return false;
    record.count += 1;
    if (record.count >= this.maxFailures) {
      record.lockedUntil = now + this.windowMs;
      record.count = 0;
      record.windowStart = now;
      return true;
    }
    return false;
  }

  /** A correct key clears the address' failures (not an active lockout: callers check that first). */
  succeed(address: string | null | undefined): void {
    this.records.delete(AdminFailureTracker.keyOf(address));
  }

  get trackedAddresses(): number {
    return this.records.size;
  }

  private prune(now: number): void {
    for (const [key, record] of this.records) {
      if (record.lockedUntil <= now && now - record.windowStart > this.windowMs) this.records.delete(key);
    }
    // Still over the cap (a flood inside one window): drop the oldest entries first.
    if (this.records.size > MAX_TRACKED_ADDRESSES) {
      const overflow = this.records.size - MAX_TRACKED_ADDRESSES;
      let removed = 0;
      for (const key of this.records.keys()) {
        if (removed++ >= overflow) break;
        this.records.delete(key);
      }
    }
  }
}

/** Expands an IPv6 address into its eight 16-bit groups (lowercase hex, no leading zeros), or null when malformed. */
function expandIpv6(address: string): string[] | null {
  let text = address.toLowerCase();
  const v4 = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const parts = v4[1]!.split(".").map(Number);
    text = text.slice(0, -v4[1]!.length) + ((parts[0]! << 8) | parts[1]!).toString(16) + ":" + ((parts[2]! << 8) | parts[3]!).toString(16);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
  const groups = [...head, ...(halves.length === 2 ? Array(missing).fill("0") : []), ...tail];
  return groups.map((group) => (parseInt(group, 16) || 0).toString(16));
}

export type AdminGuard = {
  /** 404 for addresses outside ADMIN_ALLOWED_IPS (everything admin: routes, panel page, monitor). */
  allowlist: express.RequestHandler;
  /** Key gate for `/admin/*`: lockout, then the `x-config-api-key` header (header only, never the query string). */
  requireKey: express.RequestHandler;
  /** Same gate for the dev monitor, which a browser reaches with HTTP Basic auth (any user name, the admin key as password). */
  requireBasicAuth: express.RequestHandler;
  tracker: AdminFailureTracker;
  allowList: AddressAllowList;
};

/** The Express handlers share one failure tracker, so wrong keys on any admin surface count together. */
export function createAdminGuard(options: AdminGuardOptions): AdminGuard {
  const allowList = new AddressAllowList(options.allowedIps);
  const tracker = new AdminFailureTracker(Math.max(1, options.maxFailures), options.lockoutSeconds, options.now);

  const deny404: express.RequestHandler = (_req, res) => {
    res.status(404).json({ ok: false, error: "NOT_FOUND" });
  };

  const allowlist: express.RequestHandler = (req, res, next) => {
    if (allowList.size > 0 && !allowList.allows(req.ip)) {
      deny404(req, res, next);
      return;
    }
    next();
  };

  const check = (provided: string | undefined, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!options.apiKey) {
      res.status(404).json({ ok: false, error: "ADMIN_DISABLED" });
      return;
    }
    const retry = tracker.lockedFor(req.ip);
    if (retry > 0) {
      res.setHeader("Retry-After", String(retry));
      res.status(429).json({ ok: false, error: "ADMIN_LOCKED", retryAfterSeconds: retry });
      return;
    }
    if (provided === undefined || !adminKeyMatches(provided, options.apiKey)) {
      if (tracker.fail(req.ip)) {
        // Address only: never the attempted key or the request path chosen by the caller.
        logger.warn(`admin key lockout for ${normalizeAddress(req.ip) ?? "unknown address"} after repeated wrong keys (${options.lockoutSeconds}s)`);
      }
      res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
      return;
    }
    tracker.succeed(req.ip);
    next();
  };

  const requireKey: express.RequestHandler = (req, res, next) => {
    // `req.get` returns the first value of a repeated header; a list ("a, b") simply never matches.
    check(req.get("x-config-api-key") ?? undefined, req, res, next);
  };

  const requireBasicAuth: express.RequestHandler = (req, res, next) => {
    const header = req.get("authorization") ?? "";
    let provided: string | undefined;
    if (/^basic /i.test(header)) {
      const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      provided = colon < 0 ? decoded : decoded.slice(colon + 1);
    }
    if (provided === undefined && options.apiKey && tracker.lockedFor(req.ip) === 0) {
      // First visit of a browser: ask for the credentials without counting it as a wrong guess.
      res.setHeader("WWW-Authenticate", 'Basic realm="Arena admin", charset="UTF-8"');
      res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
      return;
    }
    check(provided, req, res, next);
  };

  return { allowlist, requireKey, requireBasicAuth, tracker, allowList };
}
