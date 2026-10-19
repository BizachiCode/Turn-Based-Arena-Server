import { z } from "zod";
import { id, strictPayload } from "../../shared/validation.js";
import { RANKING_MAX_TOP } from "../../config/RankingCatalog.js";

export const RankingCategoriesSchema = strictPayload({});
export const RankingListSchema = strictPayload({
  category: id(32),
  limit: z.coerce.number().int().min(1).max(RANKING_MAX_TOP).optional(),
});
