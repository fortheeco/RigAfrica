// Fairness audit (spec §6.3): median score gap between low- and high-footprint members, overall
// and by place, and by optional self-reported gender (never inferred). Groups under k_min are
// banded and get no median, so the report itself is safe to serve through pal-api.

import { AXES } from '../../packages/pal-core/src/config.ts';
import { bandCount } from '../../packages/pal-core/src/privacy.ts';
import type { BandedCount } from '../../packages/pal-core/src/privacy.ts';
import type { PersonProfile } from '../../packages/pal-core/src/scoring.ts';
import type { SimulationRun } from './simulate.ts';

export interface FairnessGroupGap {
  group: string;
  low_n: BandedCount;
  high_n: BandedCount;
  median_low: number | null;
  median_high: number | null;
  /** median_high - median_low; null when either side is under k_min. */
  median_gap: number | null;
  flagged: boolean;
}

export interface FairnessReport {
  generated_at: string;
  model_version: string;
  dataset: 'synthetic' | 'live';
  score_basis: 'top_match_score';
  threshold: number;
  k_min: number;
  footprint: { overall: FairnessGroupGap; by_place: FairnessGroupGap[] };
  gender: FairnessGroupGap[];
  flags: string[];
  metrics?: Record<string, unknown>;
}

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** A person's top matching score B over every sector and axis (0 when nothing scored). */
export function topMatchScore(p: PersonProfile): number {
  let best = 0;
  for (const s of p.sectors) for (const a of AXES) best = Math.max(best, s.axes[a].match);
  return best;
}

export function groupGap(group: string, low: readonly number[], high: readonly number[], kMin: number, threshold: number): FairnessGroupGap {
  const ok = low.length >= kMin && high.length >= kMin;
  const mLow = ok ? median(low) : null;
  const mHigh = ok ? median(high) : null;
  const gap = mLow === null || mHigh === null ? null : Math.round((mHigh - mLow) * 100) / 100;
  return {
    group,
    low_n: bandCount(low.length, kMin),
    high_n: bandCount(high.length, kMin),
    median_low: mLow === null ? null : Math.round(mLow * 100) / 100,
    median_high: mHigh === null ? null : Math.round(mHigh * 100) / 100,
    median_gap: gap,
    flagged: gap !== null && Math.abs(gap) > threshold,
  };
}

export function fairnessAudit(run: SimulationRun, opts: { generated_at: string; dataset: 'synthetic' | 'live' }): FairnessReport {
  const first = run.instances[0];
  if (first === undefined) throw new Error('no instances in run');
  const kMin = first.cfg.privacy.k_min;
  const threshold = first.cfg.fairness.max_median_gap;
  const rows = run.instances.flatMap((i) =>
    i.members.map((m) => ({ place: m.member.place_id, footprint: m.member.footprint, gender: m.member.gender, score: topMatchScore(m.profile) })),
  );
  const split = (rs: typeof rows) => [rs.filter((r) => r.footprint === 'low').map((r) => r.score), rs.filter((r) => r.footprint === 'high').map((r) => r.score)] as const;

  const [lo, hi] = split(rows);
  const overall = groupGap('all', lo, hi, kMin, threshold);
  const by_place = [...new Set(rows.map((r) => r.place))].sort().map((place) => {
    const [l, h] = split(rows.filter((r) => r.place === place));
    return groupGap(place, l, h, kMin, threshold);
  });
  // Gender: each self-reported group (low side) vs every other member who self-reported (high side).
  const reported = rows.filter((r) => r.gender !== null);
  const gender = [...new Set(reported.map((r) => r.gender as string))].sort().map((g) =>
    groupGap(
      `gender:${g}`,
      reported.filter((r) => r.gender === g).map((r) => r.score),
      reported.filter((r) => r.gender !== g).map((r) => r.score),
      kMin,
      threshold,
    ),
  );
  const flags = [overall, ...by_place, ...gender]
    .filter((g) => g.flagged)
    .map((g) => `${g.group}: median gap ${String(g.median_gap)} exceeds ${threshold}`);
  return {
    generated_at: opts.generated_at,
    model_version: first.cfg.model_version,
    dataset: opts.dataset,
    score_basis: 'top_match_score',
    threshold,
    k_min: kMin,
    footprint: { overall, by_place },
    gender,
    flags,
  };
}
