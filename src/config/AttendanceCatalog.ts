// Daily attendance (check-in) calendar (`attendance.json`, exported from the Unity AttendanceDefinition asset). Every
// game day the player may claim the next day of the cycle; after the last day the cycle starts again. See
// docs/PROTOCOL.md `missions` → Attendance. camelCase and PascalCase keys (JsonUtility output) are accepted.

import fs from "node:fs";
import * as fsp from "node:fs/promises";
import { z } from "zod";
import { locateCatalogFile } from "./catalog-file-locator.js";
import { camelizeKeys, emptyPayload, ShopPackPayloadSchema, type ShopPackPayload } from "./ShopCatalog.js";

const reward = (currencies: Array<{ currencyId: string; amount: number }>, extra: Partial<ShopPackPayload> = {}): ShopPackPayload =>
  ({ ...emptyPayload(), currencies, ...extra });

const DaySchema = z.object({ rewards: ShopPackPayloadSchema.default(emptyPayload()) });

/** Sample 7-day cycle (used until an `attendance.json` is exported). */
const DEFAULT_DAYS: z.input<typeof DaySchema>[] = [
  { rewards: reward([{ currencyId: "GO", amount: 5000 }]) },
  { rewards: reward([{ currencyId: "EN", amount: 20 }]) },
  { rewards: reward([{ currencyId: "DM", amount: 10 }]) },
  { rewards: reward([{ currencyId: "GO", amount: 10000 }]) },
  { rewards: reward([{ currencyId: "EN", amount: 30 }]) },
  { rewards: reward([{ currencyId: "DM", amount: 20 }]) },
  { rewards: reward([{ currencyId: "mystic_scroll_cur", amount: 1 }]) },
];

export const AttendanceConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Check-in days start at this UTC hour. */
  resetHourUtc: z.coerce.number().int().min(0).max(23).default(0),
  /** One entry per day of the cycle (day 1 first). */
  days: z.array(DaySchema).max(62).default(() => DEFAULT_DAYS.map((day) => DaySchema.parse(day))),
});
export type AttendanceConfig = z.infer<typeof AttendanceConfigSchema>;

let catalog: AttendanceConfig = AttendanceConfigSchema.parse({});

export function parseAttendanceConfig(rawText: string): AttendanceConfig {
  return AttendanceConfigSchema.parse(camelizeKeys(JSON.parse(rawText)));
}

export function getAttendanceConfig(): AttendanceConfig {
  return catalog;
}

/** Replaces the in-memory config (tests / programmatic setups). */
export function setAttendanceConfig(next: AttendanceConfig): void {
  catalog = next;
}

export function loadAttendanceConfigOnce(): AttendanceConfig {
  const file = locateCatalogFile("attendance.json");
  if (!file) {
    console.warn("[AttendanceConfig] attendance.json not found; using the sample calendar.");
    return catalog;
  }
  catalog = parseAttendanceConfig(fs.readFileSync(file, "utf8"));
  console.log(`[AttendanceConfig] loaded ${catalog.days.length} days from: ${file}`);
  return catalog;
}

export async function reloadAttendanceConfigFromFile(filePath: string): Promise<AttendanceConfig> {
  catalog = parseAttendanceConfig(await fsp.readFile(filePath, "utf8"));
  console.log(`[AttendanceConfig] reloaded from: ${filePath}`);
  return catalog;
}

