export interface ChickenIndexWeights {
  kd: number;
  avgDamage: number;
  avgKills: number;
  placement: number;
  top10Rate: number;
}

export const CHICKEN_INDEX_WEIGHTS: Readonly<ChickenIndexWeights> = Object.freeze({
  kd: 0.35,
  avgDamage: 0.3,
  avgKills: 0.2,
  placement: 0.1,
  top10Rate: 0.05,
});

export function normalizeChickenIndexWeights(
  override: Partial<ChickenIndexWeights> = {},
): ChickenIndexWeights {
  const values = {
    kd:
      Number.isFinite(override.kd) && (override.kd ?? 0) >= 0
        ? Number(override.kd)
        : CHICKEN_INDEX_WEIGHTS.kd,
    avgDamage:
      Number.isFinite(override.avgDamage) && (override.avgDamage ?? 0) >= 0
        ? Number(override.avgDamage)
        : CHICKEN_INDEX_WEIGHTS.avgDamage,
    avgKills:
      Number.isFinite(override.avgKills) && (override.avgKills ?? 0) >= 0
        ? Number(override.avgKills)
        : CHICKEN_INDEX_WEIGHTS.avgKills,
    placement:
      Number.isFinite(override.placement) && (override.placement ?? 0) >= 0
        ? Number(override.placement)
        : CHICKEN_INDEX_WEIGHTS.placement,
    top10Rate:
      Number.isFinite(override.top10Rate) && (override.top10Rate ?? 0) >= 0
        ? Number(override.top10Rate)
        : CHICKEN_INDEX_WEIGHTS.top10Rate,
  };
  const total = Object.values(values).reduce((sum, value) => sum + value, 0);
  if (total <= 0) return { ...CHICKEN_INDEX_WEIGHTS };
  return {
    kd: values.kd / total,
    avgDamage: values.avgDamage / total,
    avgKills: values.avgKills / total,
    placement: values.placement / total,
    top10Rate: values.top10Rate / total,
  };
}
