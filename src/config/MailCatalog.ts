// Server-side mailbox configuration (`mail.json`, exported from the Unity MailDefinition asset): inbox size, default
// expiration and the welcome mail every new player receives. See docs/PROTOCOL.md `mail`.
// camelCase and PascalCase keys (JsonUtility output) are accepted.

import fs from "node:fs";
import * as fsp from "node:fs/promises";
import { z } from "zod";
import { locateCatalogFile } from "./catalog-file-locator.js";
import { camelizeKeys, emptyPayload, ShopPackPayloadSchema } from "./ShopCatalog.js";

const int = (fallback: number, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const text = (max: number, fallback = "") => z.preprocess((raw) => (raw == null ? fallback : String(raw)), z.string().max(max));
const key = z.preprocess((raw) => (raw == null || raw === "" ? null : String(raw)), z.string().max(64).nullable());

/** Welcome mail of the sample content (used until a `mail.json` is exported). */
const DEFAULT_WELCOME = {
  enabled: true,
  sender: "Arena Council",
  titleKey: "text_mail_welcome_title",
  title: "Welcome, Summoner!",
  bodyKey: "text_mail_welcome_body",
  body: "Welcome to the arena! Here are a few gifts to start your journey. Good luck!",
  expirationDays: 30,
  attachments: { ...emptyPayload(), currencies: [{ currencyId: "DM", amount: 100 }, { currencyId: "GO", amount: 20000 }] },
};

export const MailTemplateSchema = z.object({
  enabled: z.boolean().default(true),
  sender: text(32),
  /** Translation keys (the client falls back to the literal texts). */
  titleKey: key.default(null),
  title: text(80),
  bodyKey: key.default(null),
  body: text(1000),
  /** 0 = never expires. */
  expirationDays: int(30, 0, 3650),
  attachments: ShopPackPayloadSchema.default(emptyPayload()),
});

export const MailConfigSchema = z.object({
  /** Mails shown in the inbox (newest first). Older read mails without pending rewards are deleted when it overflows. */
  inboxLimit: int(100, 10, 500),
  /** Expiration of mails sent without an explicit one (GM mails, guild notices). 0 = never. */
  defaultExpirationDays: int(30, 0, 3650),
  welcome: MailTemplateSchema.default(DEFAULT_WELCOME),
});

export type MailConfig = z.infer<typeof MailConfigSchema>;
export type MailTemplate = z.infer<typeof MailTemplateSchema>;

let catalog: MailConfig = MailConfigSchema.parse({});

/** Parses and validates `mail.json` (throws on invalid data). */
export function parseMailConfig(rawText: string): MailConfig {
  return MailConfigSchema.parse(camelizeKeys(JSON.parse(rawText)));
}

export function getMailConfig(): MailConfig {
  return catalog;
}

/** Replaces the in-memory config (tests / programmatic setups). */
export function setMailConfig(next: MailConfig): void {
  catalog = next;
}

export function loadMailConfigOnce(): MailConfig {
  const file = locateCatalogFile("mail.json");
  if (!file) {
    console.warn("[MailConfig] mail.json not found; using defaults.");
    return catalog;
  }
  catalog = parseMailConfig(fs.readFileSync(file, "utf8"));
  console.log(`[MailConfig] loaded from: ${file}`);
  return catalog;
}

export async function reloadMailConfigFromFile(filePath: string): Promise<MailConfig> {
  catalog = parseMailConfig(await fsp.readFile(filePath, "utf8"));
  console.log(`[MailConfig] reloaded from: ${filePath}`);
  return catalog;
}

