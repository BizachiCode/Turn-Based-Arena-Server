// Tutorial guaranteed summons (`config.json > tutorial > guaranteedSummons`, exported from the Unity
// TutorialDefinition): the first summons of an account with a scroll give these monsters in order, then the scroll
// rolls as usual. The count of summons per scroll lives in `user_summon_counters`.

import { z } from "zod";

const GuaranteedSummonSchema = z.object({
  scrollId: z.string().trim().min(1).max(64),
  characterIds: z.array(z.string().trim().min(1).max(64)).max(50).default([]),
});

const TutorialSummonsSchema = z.object({
  guaranteedSummons: z.array(GuaranteedSummonSchema).max(20).default([]),
});

/** Guaranteed monsters per scroll id (in summon order). */
export type GuaranteedSummons = ReadonlyMap<string, readonly string[]>;

/** Parses the `tutorial` block; anything invalid means no guarantees. */
export function normalizeGuaranteedSummons(raw: unknown): GuaranteedSummons {
  const parsed = TutorialSummonsSchema.safeParse(raw ?? {});
  const map = new Map<string, string[]>();
  if (!parsed.success) return map;
  for (const entry of parsed.data.guaranteedSummons) {
    if (entry.characterIds.length === 0) continue;
    map.set(entry.scrollId, [...(map.get(entry.scrollId) ?? []), ...entry.characterIds]);
  }
  return map;
}
