// src/shared/errors/app-error.ts
// Typed error carrying a stable error code (the client localizes it) plus optional payload.

export type AppErrorOptions = {
  /** Nested details, serialized as `extra` (e.g. ban reason/until, missing currency). */
  extra?: Record<string, unknown>;
  /** Fields merged at the top level of the error response (e.g. `requiredLevel`). */
  fields?: Record<string, unknown>;
  /** Human readable message (logs / rooms that answer with `{ code, message }`). */
  message?: string;
};

export class AppError extends Error {
  public readonly errorCode: string;
  public readonly extra?: Record<string, unknown>;
  public readonly fields?: Record<string, unknown>;

  constructor(errorCode: string, extraOrOptions?: Record<string, unknown> | AppErrorOptions) {
    const options = normalizeOptions(extraOrOptions);
    super(options.message ?? errorCode);
    this.name = "AppError";
    this.errorCode = errorCode;
    this.extra = options.extra;
    this.fields = options.fields;
  }

  /** Default `{ ok: false, error, extra?, ...fields }` response body. */
  toResponse(): Record<string, unknown> & { ok: false; error: string } {
    return {
      ok: false,
      error: this.errorCode,
      ...(this.extra ? { extra: this.extra } : {}),
      ...(this.fields ?? {}),
    };
  }
}

function normalizeOptions(value?: Record<string, unknown> | AppErrorOptions): AppErrorOptions {
  if (!value) return {};
  const keys = Object.keys(value);
  const isOptions = keys.length > 0 && keys.every((key) => key === "extra" || key === "fields" || key === "message");
  return isOptions ? (value as AppErrorOptions) : { extra: value as Record<string, unknown> };
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
