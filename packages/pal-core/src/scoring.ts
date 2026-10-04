// Person scoring (spec 5.1). Pure: callers supply evidence, claimed items, history and `now`.
//
//   V(a,s) = min(100, points_per_unit * SUM_e [ w_e * q_e * m_e * 2^(-age_months_e / half_life_months) ])
//   C(a,s) = min(claimed_cap_per_axis, claimed_points_per_item * weighted count of distinct claimed items)
//   B(a,s) = min(100, V + claimed_match_weight * C)
//
// Stingy rule: only verified/corroborated ECO evidence can move V. Claimed items only move C.

import { AXES, ROLE_LABEL } from './config.ts';
import type { Axis, ResolvedConfig, RoleLabel, VerificationLevel } from './config.ts';
import { confidence } from './confidence.ts';

/** Average Gregorian month in ms (365.25 / 12 days). An integer, so whole-month ages are exact. */
export const MS_PER_MONTH = 2_629_800_000;
export const MS_PER_DAY = 86_400_000;

export interface VerifiedEvidence {
  /** Stable evidence-line id; the person disputes by this id. */
  id: string;
  axis: Axis;
  sector: string;
  evidence_type: string;
  /** q_e in [0,1]; null when the source event has no quality field (treated as 1.0). */
  quality: number | null;
  verification_level: VerificationLevel;
  occurred_at: string;
  verifier_id: string | null;
  source_ref: string;
}

export interface ClaimedItem {
  id: string;
  axis: Axis | null;
  sector: string | null;
  feature_type: string;
  value: string;
  /** 1.0 normally; reduced for languages that have not passed validation. */
  weight: number;
  evidence_ref: string;
}

export interface ProfileHistoryPoint {
  taken_at: string;
  /** Verified score V keyed by scoreKey(sector, axis). */
  verified: Readonly<Record<string, number>>;
}

export type PersonState = 'Rising' | 'Established' | 'Dormant' | 'Unverified' | 'Emerging';

export interface AxisScore {
  verified: number;
  claimed: number;
  match: number;
  confidence: number;
  state: PersonState;
  distinct_evidence_types: number;
  distinct_verifiers: number;
  verified_baseline_90d: number;
  peak_verified: number;
}

export interface SectorRole {
  axis: Axis;
  label: RoleLabel;
  primary: boolean;
}

export interface SectorProfile {
  sector: string;
  axes: Record<Axis, AxisScore>;
  roles: SectorRole[];
}

export type EvidenceStatus =
  | 'counted' // contributes to V (verified lines) or C (claimed lines)
  | 'frozen' // under open dispute: excluded until resolved
  | 'not_verified' // verification level 'unverified': contributes 0
  | 'no_weight' // evidence type has no weight on this axis
  | 'duplicate' // claimed item already counted (same type + normalised value)
  | 'unscoped'; // sector or axis missing / not configured

export interface EvidenceLine {
  id: string;
  kind: 'verified' | 'claimed';
  axis: Axis | null;
  sector: string | null;
  type: string;
  verification_level: VerificationLevel | 'claimed';
  status: EvidenceStatus;
  /** Points this line adds to V (verified lines) or C before the cap (claimed lines). */
  points: number;
  source_ref: string;
  occurred_at: string | null;
}

export interface PersonProfile {
  person_id: string;
  model_version: string;
  computed_at: string;
  sectors: SectorProfile[];
  evidence_lines: EvidenceLine[];
}

export interface ScoreInput {
  person_id: string;
  evidence: readonly VerifiedEvidence[];
  claimed: readonly ClaimedItem[];
  /** Evidence-line ids (verified or claimed) under an open dispute. */
  frozen_ids: ReadonlySet<string>;
  history: readonly ProfileHistoryPoint[];
  now: string;
}

export function scoreKey(sector: string, axis: Axis): string {
  return `${sector}:${axis}`;
}

export function ageMonths(occurredAt: string, now: string): number {
  const ms = Date.parse(now) - Date.parse(occurredAt);
  return Math.max(0, ms / MS_PER_MONTH);
}

export function decayFactor(ageInMonths: number, halfLifeMonths: number): number {
  return Math.pow(2, -Math.max(0, ageInMonths) / halfLifeMonths);
}

/** Unclamped contribution of one evidence item, in V points. 0 for unverified or unweighted. */
export function evidenceContribution(
  e: Pick<VerifiedEvidence, 'axis' | 'evidence_type' | 'quality' | 'verification_level'>,
  ageInMonths: number,
  cfg: ResolvedConfig['scoring'],
): number {
  const w = cfg.evidence_weights[e.axis][e.evidence_type] ?? 0;
  const q = e.quality === null ? 1 : Math.min(1, Math.max(0, e.quality));
  const m = cfg.verification_multiplier[e.verification_level];
  return cfg.points_per_unit * w * q * m * decayFactor(ageInMonths, cfg.half_life_months);
}

export function normaliseValue(v: string): string {
  return v.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

interface Accum {
  raw: number;
  types: Set<string>;
  verifiers: Set<string>;
}

function verifiedTotals(
  evidence: readonly VerifiedEvidence[],
  frozen: ReadonlySet<string>,
  sectors: ReadonlySet<string>,
  now: string,
  cfg: ResolvedConfig,
  lines: EvidenceLine[] | null,
): Map<string, Accum> {
  const acc = new Map<string, Accum>();
  const nowMs = Date.parse(now);
  for (const e of evidence) {
    if (Date.parse(e.occurred_at) > nowMs) continue; // not yet happened as of `now`
    let status: EvidenceStatus = 'counted';
    let points = 0;
    if (!sectors.has(e.sector)) status = 'unscoped';
    else if (frozen.has(e.id)) status = 'frozen';
    else if (e.verification_level === 'unverified') status = 'not_verified';
    else if ((cfg.scoring.evidence_weights[e.axis][e.evidence_type] ?? 0) <= 0) status = 'no_weight';
    else points = evidenceContribution(e, ageMonths(e.occurred_at, now), cfg.scoring);
    if (status === 'counted' && points > 0) {
      const k = scoreKey(e.sector, e.axis);
      const a = acc.get(k) ?? { raw: 0, types: new Set<string>(), verifiers: new Set<string>() };
      a.raw += points;
      a.types.add(e.evidence_type);
      if (e.verifier_id !== null) a.verifiers.add(e.verifier_id);
      acc.set(k, a);
    }
    lines?.push({
      id: e.id,
      kind: 'verified',
      axis: e.axis,
      sector: e.sector,
      type: e.evidence_type,
      verification_level: e.verification_level,
      status,
      points,
      source_ref: e.source_ref,
      occurred_at: e.occurred_at,
    });
  }
  return acc;
}

/** V for every (sector, axis) as of `asOf`, using only evidence that had occurred by then. */
export function verifiedScoresAsOf(
  evidence: readonly VerifiedEvidence[],
  frozen: ReadonlySet<string>,
  asOf: string,
  cfg: ResolvedConfig,
): Map<string, number> {
  const acc = verifiedTotals(evidence, frozen, new Set(cfg.sectors), asOf, cfg, null);
  const out = new Map<string, number>();
  for (const [k, a] of acc) out.set(k, Math.min(100, a.raw));
  return out;
}

function claimedTotals(
  claimed: readonly ClaimedItem[],
  frozen: ReadonlySet<string>,
  sectors: ReadonlySet<string>,
  cfg: ResolvedConfig,
  lines: EvidenceLine[],
): Map<string, number> {
  // Distinct by (sector, axis, type, normalised value); the heaviest duplicate wins.
  const best = new Map<string, { item: ClaimedItem; weight: number }>();
  const statuses = new Map<string, EvidenceStatus>();
  for (const item of claimed) {
    if (item.axis === null || item.sector === null || !sectors.has(item.sector)) {
      statuses.set(item.id, 'unscoped');
      continue;
    }
    if (frozen.has(item.id)) {
      statuses.set(item.id, 'frozen');
      continue;
    }
    const key = `${item.sector}|${item.axis}|${item.feature_type}|${normaliseValue(item.value)}`;
    const weight = Math.min(1, Math.max(0, item.weight));
    const prev = best.get(key);
    if (prev === undefined || weight > prev.weight) {
      if (prev !== undefined) statuses.set(prev.item.id, 'duplicate');
      best.set(key, { item, weight });
      statuses.set(item.id, 'counted');
    } else {
      statuses.set(item.id, 'duplicate');
    }
  }
  const totals = new Map<string, number>();
  const pointsById = new Map<string, number>();
  for (const { item, weight } of best.values()) {
    const k = scoreKey(item.sector as string, item.axis as Axis);
    const pts = cfg.scoring.claimed_points_per_item * weight;
    pointsById.set(item.id, pts);
    totals.set(k, (totals.get(k) ?? 0) + pts);
  }
  for (const item of claimed) {
    lines.push({
      id: item.id,
      kind: 'claimed',
      axis: item.axis,
      sector: item.sector,
      type: item.feature_type,
      verification_level: 'claimed',
      status: statuses.get(item.id) ?? 'unscoped',
      points: pointsById.get(item.id) ?? 0,
      source_ref: item.evidence_ref,
      occurred_at: null,
    });
  }
  for (const [k, v] of totals) totals.set(k, Math.min(cfg.scoring.claimed_cap_per_axis, v));
  return totals;
}

export function matchScore(verified: number, claimed: number, cfg: ResolvedConfig): number {
  return Math.min(100, verified + cfg.scoring.claimed_match_weight * claimed);
}

export function classifyState(
  s: { verified: number; claimed: number; baseline: number; peak: number },
  cfg: ResolvedConfig,
): PersonState {
  const st = cfg.states;
  if (s.verified - s.baseline >= st.rising_delta_90d) return 'Rising';
  if (s.verified >= st.established_min) return 'Established';
  if (s.verified < st.dormant_below && s.peak >= st.dormant_if_peak_at_least) return 'Dormant';
  if (s.verified === 0 && s.claimed > 0) return 'Unverified';
  return 'Emerging';
}

/** Roles for one sector from match scores B: primary if B >= threshold, plus at most one more. */
export function assignRoles(match: Readonly<Record<Axis, number>>, cfg: ResolvedConfig): SectorRole[] {
  const ranked = AXES.filter((a) => match[a] >= cfg.roles.role_threshold).sort(
    (x, y) => match[y] - match[x] || AXES.indexOf(x) - AXES.indexOf(y),
  );
  const top = ranked[0];
  if (top === undefined) return [];
  const roles: SectorRole[] = [{ axis: top, label: ROLE_LABEL[top], primary: true }];
  const second = ranked[1];
  if (second !== undefined && match[second] >= cfg.roles.multi_role_ratio * match[top]) {
    roles.push({ axis: second, label: ROLE_LABEL[second], primary: false });
  }
  return roles;
}

const DAYS_90_MS = 90 * MS_PER_DAY;

/** Baseline V 90 days ago: latest history snapshot at or before now-90d, else recomputed as-of. */
function baselines(input: ScoreInput, cfg: ResolvedConfig): { baseline: Map<string, number>; peaks: Map<string, number> } {
  const cutoff = Date.parse(input.now) - DAYS_90_MS;
  const sorted = [...input.history].sort((a, b) => Date.parse(a.taken_at) - Date.parse(b.taken_at));
  let snapshot: ProfileHistoryPoint | undefined;
  for (const h of sorted) if (Date.parse(h.taken_at) <= cutoff) snapshot = h;
  const baseline =
    snapshot !== undefined
      ? new Map(Object.entries(snapshot.verified))
      : verifiedScoresAsOf(input.evidence, input.frozen_ids, new Date(cutoff).toISOString(), cfg);
  const peaks = new Map<string, number>();
  for (const h of sorted) {
    for (const [k, v] of Object.entries(h.verified)) peaks.set(k, Math.max(peaks.get(k) ?? 0, v));
  }
  for (const [k, v] of baseline) peaks.set(k, Math.max(peaks.get(k) ?? 0, v));
  return { baseline, peaks };
}

/** Full profile recompute for one person. */
export function computeProfile(input: ScoreInput, cfg: ResolvedConfig): PersonProfile {
  const sectors = new Set(cfg.sectors);
  const lines: EvidenceLine[] = [];
  const vAcc = verifiedTotals(input.evidence, input.frozen_ids, sectors, input.now, cfg, lines);
  const cTot = claimedTotals(input.claimed, input.frozen_ids, sectors, cfg, lines);
  const { baseline, peaks } = baselines(input, cfg);

  const touched = new Set<string>();
  for (const k of [...vAcc.keys(), ...cTot.keys(), ...peaks.keys()]) touched.add(k.split(':')[0] as string);

  const out: SectorProfile[] = [];
  for (const sector of cfg.sectors) {
    if (!touched.has(sector)) continue;
    const axes = {} as Record<Axis, AxisScore>;
    const match = {} as Record<Axis, number>;
    for (const axis of AXES) {
      const k = scoreKey(sector, axis);
      const a = vAcc.get(k);
      const verified = Math.min(100, a?.raw ?? 0);
      const claimed = cTot.get(k) ?? 0;
      const b = matchScore(verified, claimed, cfg);
      const base = baseline.get(k) ?? 0;
      const peak = Math.max(peaks.get(k) ?? 0, verified);
      match[axis] = b;
      axes[axis] = {
        verified,
        claimed,
        match: b,
        confidence: confidence({
          verified,
          claimed,
          distinctEvidenceTypes: a?.types.size ?? 0,
          distinctVerifiers: a?.verifiers.size ?? 0,
        }),
        state: classifyState({ verified, claimed, baseline: base, peak }, cfg),
        distinct_evidence_types: a?.types.size ?? 0,
        distinct_verifiers: a?.verifiers.size ?? 0,
        verified_baseline_90d: base,
        peak_verified: peak,
      };
    }
    out.push({ sector, axes, roles: assignRoles(match, cfg) });
  }

  return {
    person_id: input.person_id,
    model_version: cfg.model_version,
    computed_at: input.now,
    sectors: out,
    evidence_lines: lines,
  };
}

/** Snapshot to append to pal_profile_history after a recompute. */
export function historyPoint(profile: PersonProfile): ProfileHistoryPoint {
  const verified: Record<string, number> = {};
  for (const s of profile.sectors) for (const a of AXES) verified[scoreKey(s.sector, a)] = s.axes[a].verified;
  return { taken_at: profile.computed_at, verified };
}
