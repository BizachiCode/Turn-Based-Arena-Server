import type express from "express";
import { z } from "zod";
import { AppError } from "../../shared/errors/app-error.js";
import { createLogger } from "../../shared/logger.js";

const logger = createLogger("RuntimeAdmin");

/** Error answer of every `/admin/runtime` route: zod issues, domain errors and operator mistakes become 400s. */
export function sendAdminError(res: express.Response, error: unknown) {
  if (error instanceof z.ZodError) {
    res.status(400).json({
      ok: false,
      error: "INVALID_PAYLOAD",
      detail: error.issues.map((issue) => issue.message).join("; "),
    });
    return;
  }

  if (error instanceof AppError) {
    res.status(400).json({ ok: false, error: error.errorCode, detail: error.extra ?? null });
    return;
  }

  logger.error("request failed:", error);
  // Validation messages thrown by the grant service are safe to show; anything else stays generic.
  const message = error instanceof Error && !("sqlMessage" in error) && !("code" in error) ? error.message : null;
  res.status(message ? 400 : 500).json({ ok: false, error: message ? "INVALID_REQUEST" : "SERVER_ERROR", detail: message });
}

/** Wraps a handler: parses nothing itself, answers `{ ok: true, ...result }` or the error answer. */
export function adminRoute(handler: (req: express.Request) => Promise<object>): express.RequestHandler {
  return async (req, res) => {
    try {
      res.json({ ok: true, ...(await handler(req)) });
    } catch (error) {
      sendAdminError(res, error);
    }
  };
}
