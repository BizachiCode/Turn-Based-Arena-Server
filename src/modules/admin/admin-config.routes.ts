// `/admin/config` — GET the live config, POST /import (Unity export bundle as a zip, or config.json as a JSON body).
//
// Hardened replacement of the old catalog router: the admin key is checked before any body is read or parsed, the zip is
// inspected (entry count, declared sizes, hostile names, symlinks) before anything is extracted, bodies are bounded while
// streaming, and error answers never carry stack traces, file paths or SQL.

import AdmZip from "adm-zip";
import express from "express";
import { z } from "zod";

import type { CatalogService } from "../catalog/catalog.service.js";
import type { AuditLog } from "../../shared/kernel/audit.js";
import { createLogger } from "../../shared/logger.js";
import { requireAdminKey } from "./admin-auth.js";

const logger = createLogger("CatalogAdmin");

export type BundleLimits = {
  /** Largest zip accepted over HTTP. */
  maxZipBytes: number;
  /** Largest `config.json` body. */
  maxJsonBytes: number;
  /** Most entries inside the zip. */
  maxEntries: number;
  /** Largest declared (uncompressed) size of one entry. */
  maxEntryBytes: number;
  /** Largest declared (uncompressed) size of all entries together. */
  maxTotalBytes: number;
};

export const DEFAULT_BUNDLE_LIMITS: BundleLimits = {
  maxZipBytes: 50 * 1024 * 1024,
  maxJsonBytes: 10 * 1024 * 1024,
  maxEntries: 400,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
};

/** Raised for a bundle the importer must not touch; the message is safe to show to the operator. */
export class BundleRejectedError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const SYMLINK_MODE = 0o120000;
const FILE_TYPE_MASK = 0o170000;

/** True for names that could leave the extraction folder or confuse the filesystem. */
export function isHostileEntryName(name: string): boolean {
  if (!name || name.length > 260) return true;
  if (name.includes("\0")) return true;
  if (name.startsWith("/") || name.startsWith("\\") || /^[A-Za-z]:/.test(name)) return true;
  return name.split(/[\\/]+/).some((part) => part === "..");
}

/**
 * Looks at the zip directory only (nothing is decompressed): the declared sizes bound what `extractAllTo` writes,
 * because adm-zip caps every inflate at the declared size.
 */
export function assertSafeBundle(zipBuffer: Buffer, limits: BundleLimits = DEFAULT_BUNDLE_LIMITS): void {
  if (zipBuffer.length === 0) throw new BundleRejectedError("Empty bundle.");
  if (zipBuffer.length > limits.maxZipBytes) throw new BundleRejectedError("Bundle too large.", 413);

  let entries: AdmZip.IZipEntry[];
  try {
    entries = new AdmZip(zipBuffer).getEntries();
  } catch {
    throw new BundleRejectedError("The bundle is not a valid zip file.");
  }
  if (entries.length > limits.maxEntries) throw new BundleRejectedError(`The bundle has too many entries (limit ${limits.maxEntries}).`);

  let total = 0;
  for (const entry of entries) {
    if (isHostileEntryName(entry.entryName)) throw new BundleRejectedError("The bundle contains an unsafe file name.");
    const mode = (entry.attr >>> 16) & FILE_TYPE_MASK;
    if (mode === SYMLINK_MODE) throw new BundleRejectedError("The bundle contains a symbolic link.");
    const size = entry.header.size;
    if (!Number.isFinite(size) || size < 0 || size > limits.maxEntryBytes) throw new BundleRejectedError("A file in the bundle is too large.", 413);
    total += size;
    if (total > limits.maxTotalBytes) throw new BundleRejectedError("The bundle expands to too much data.", 413);
  }
}

/** Reads the request body into memory, answering 413 (not a reset connection) when it grows past the limit. */
async function readBounded(req: express.Request, maxBytes: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) throw new BundleRejectedError("Bundle too large.", 413);

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let finished = false;
    req.on("data", (chunk: Buffer) => {
      if (finished) return;
      size += chunk.length;
      if (size > maxBytes) {
        finished = true;
        chunks.length = 0;
        reject(new BundleRejectedError("Bundle too large.", 413));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!finished) { finished = true; resolve(Buffer.concat(chunks)); } });
    req.on("error", (error) => { if (!finished) { finished = true; reject(error); } });
  });
}

/** What the operator sees for a failed import: validation issues and our own messages, never fs/db internals. */
function importErrorAnswer(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof BundleRejectedError) {
    const code = error.status === 413 ? "PAYLOAD_TOO_LARGE" : error.status === 415 ? "UNSUPPORTED_MEDIA_TYPE" : "INVALID_BUNDLE";
    return { status: error.status, body: { ok: false, error: code, detail: error.message } };
  }
  if (error instanceof z.ZodError) {
    return { status: 400, body: { ok: false, error: "INVALID_CONFIG", detail: error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; ").slice(0, 2000) } };
  }
  if (error instanceof SyntaxError) {
    return { status: 400, body: { ok: false, error: "INVALID_CONFIG", detail: "The file is not valid JSON." } };
  }
  logger.error("import failed:", error);
  // fs/zip errors carry absolute paths: keep those in the server logs; our own `Error("...")` texts are fine to show.
  const plain = error instanceof Error && !("code" in error) && !("path" in error) && !/[A-Za-z]:\\|\/(?:home|usr|var|tmp|opt)\//.test(error.message);
  return { status: 400, body: { ok: false, error: "INVALID_CONFIG", detail: plain ? (error as Error).message.slice(0, 500) : "Import failed; see the server logs." } };
}

export function createAdminConfigRouter(deps: { service: CatalogService; apiKey: string; audit: AuditLog; limits?: Partial<BundleLimits> }): express.Router {
  const limits = { ...DEFAULT_BUNDLE_LIMITS, ...deps.limits };
  const router = express.Router();
  // Also gated by the app-level guard (lockout, allowlist); this keeps the router safe if it is mounted on its own.
  router.use(requireAdminKey(deps.apiKey));

  router.get("/", (_req, res) => {
    res.json({ ok: true, config: deps.service.getCurrentConfig() });
  });

  // The JSON parser sits behind the key check and only reads application/json bodies.
  const jsonBody = express.json({ limit: limits.maxJsonBytes });

  router.post("/import", jsonBody, async (req, res) => {
    const contentType = String(req.headers["content-type"] || "").toLowerCase();
    const isZip = contentType.includes("application/zip") || contentType.includes("application/octet-stream");
    deps.audit.record({ userId: null, kind: "ADMIN_CONFIG_IMPORT", meta: { ip: req.ip ?? null, format: isZip ? "zip" : "json" } })
      .catch((error) => logger.warn("audit failed:", (error as Error).message));
    try {
      if (isZip) {
        const zip = await readBounded(req, limits.maxZipBytes);
        assertSafeBundle(zip, limits);
        res.json(await deps.service.importZip(zip));
        return;
      }
      if (!req.is("application/json")) {
        throw new BundleRejectedError("Send config.json as application/json, or the export bundle as application/zip.", 415);
      }
      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
        throw new BundleRejectedError("config.json must be a JSON object.");
      }
      res.json(await deps.service.importJson(req.body));
    } catch (error) {
      const answer = importErrorAnswer(error);
      if (answer.status === 413) res.setHeader("Connection", "close");
      res.status(answer.status).json(answer.body);
    }
  });

  return router;
}
