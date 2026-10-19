// Turns console-style arguments into a structured entry: scope tag, one-line message, details (stacks, long text).
import util from "node:util";

export const MAX_MESSAGE_LENGTH = 2000;
export const MAX_DETAILS_LENGTH = 16_000;
export const MAX_SCOPE_LENGTH = 48;

const TAG = /^\[([^\]\r\n]{1,48})\]\s?/;
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;
const SECRET_FIELD = /\b(password|passwd|token|secret|authorization|api[_-]?key|pepper|refresh)(["']?\s*[:=]\s*["']?)(?!\[redacted\])([^"',\s}]{3,})/gi;

/** Removes tokens and secret-looking `key: value` pairs from a text before it is stored. Never throws. */
export function redactSecrets(text: string): string {
  return text.replace(JWT, "[jwt]").replace(SECRET_FIELD, "$1$2[redacted]");
}

/** `[Tag] rest` -> scope `Tag` and the rest of the text; null scope when the text has no tag. */
export function splitScope(text: string): { scope: string | null; rest: string } {
  const match = TAG.exec(text);
  if (!match) return { scope: null, rest: text };
  return { scope: match[1].trim().slice(0, MAX_SCOPE_LENGTH) || null, rest: text.slice(match[0].length) };
}

function describeError(error: Error, depth = 0): string {
  const code = (error as { code?: unknown }).code;
  const head = error.stack ?? `${error.name}: ${error.message}`;
  let text = code !== undefined && !head.includes(String(code)) ? `${head}\n  code: ${String(code)}` : head;
  const cause = (error as { cause?: unknown }).cause;
  if (cause && depth < 3) {
    text += `\nCaused by: ${cause instanceof Error ? describeError(cause, depth + 1) : safeInspect(cause)}`;
  }
  return text;
}

function safeInspect(value: unknown): string {
  try {
    return util.inspect(value, { depth: 3, breakLength: 120, maxArrayLength: 20, maxStringLength: 500 });
  } catch {
    return "[unprintable]";
  }
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/**
 * Console arguments -> `{ message, details }`. Errors are removed from the message (their message and stack go to the
 * details; the first error's message becomes the message when nothing else was passed); text with several lines keeps
 * its first line as the message. Secrets are redacted. Never throws.
 */
export function formatLogArgs(args: readonly unknown[]): { message: string; details: string | null } {
  try {
    const errors: Error[] = [];
    const rest: unknown[] = [];
    for (const arg of args) {
      if (arg instanceof Error) errors.push(arg);
      else rest.push(arg);
    }

    let text = rest.length > 0 ? util.format(...(rest as [unknown, ...unknown[]])) : "";
    const detailParts: string[] = [];

    if (!text && errors.length > 0) text = errors[0].message || errors[0].name;
    else if (errors.length > 0 && rest.length > 0 && errors.length === 1 && !text.includes(errors[0].message)) {
      // `logger.error("save failed:", error)` reads better with the reason in the line itself.
      text = `${text} ${errors[0].message}`.trim();
    }
    for (const error of errors) detailParts.push(describeError(error));

    const newline = text.indexOf("\n");
    let message = text;
    if (newline >= 0) {
      message = text.slice(0, newline);
      detailParts.unshift(text.slice(newline + 1));
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      detailParts.unshift(message);
      message = message.slice(0, MAX_MESSAGE_LENGTH - 3) + "...";
    }

    const details = detailParts.filter((part) => part.trim().length > 0).join("\n---\n");
    return {
      message: redactSecrets(message.trimEnd()),
      details: details ? cut(redactSecrets(details), MAX_DETAILS_LENGTH) : null,
    };
  } catch {
    return { message: "[unprintable log entry]", details: null };
  }
}
