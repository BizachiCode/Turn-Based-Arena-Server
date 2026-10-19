export type TowerStatusDto = {
  regionId: string;
  reset: "monthly" | "weekly" | "never";
  /** Season key, e.g. `M:2026-10`. */
  seasonKey: string;
  /** Floors cleared this season (the next floor's index). */
  clearedFloors: number;
  totalFloors: number;
  minAccountLevel: number;
  levelLocked: boolean;
  /** Next season start (unix seconds; 0 = never resets). */
  resetsAtUnix: number;
};

export type TowerStatusResponseDto = {
  ok: true;
  serverTimeUnix: number;
  towers: TowerStatusDto[];
};
