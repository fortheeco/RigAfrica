// Triad Readiness per (place, sector) (spec 5.2) and its k-anonymous public form (spec 2.7).
//
//   P_hat = min(1, partner_count / target_partner)   (same for A_hat, L_hat)
//   TR    = 100 * (P_hat * A_hat * L_hat)^(1/3)
//   uncertainty_band = (1 - mean_confidence_of_counted_people) * TR

import { AXES, ROLE_KEY, ROLE_LABEL } from './config.ts';
import type { Axis, ResolvedConfig, RoleKey, RoleLabel, RoleTargets } from './config.ts';
import { bandCount } from './privacy.ts';
import type { BandedCount } from './privacy.ts';
import type { SectorProfile } from './scoring.ts';

/** A place is data (pal_places), never code. `target_profile` names a readiness_targets entry. */
export interface Place {
  id: string;
  instance_id: string;
  name: string;
  place_type: string;
  target_profile: string;
  parent_id: string | null;
}

export interface PlaceMember {
  person_id: string;
  /** The person's profile for the cell's sector (from computeProfile). */
  sector: SectorProfile;
}

export interface OpenSparkCoverage {
  spark_id: string;
  /** Roles for which the Spark currently has no eligible candidate. */
  roles_without_candidate: readonly Axis[];
}

/** Internal, exact. Never returned by the API; use publishReadiness(). */
export interface ReadinessCell {
  place_id: string;
  sector: string;
  counts: Record<RoleKey, number>;
  hats: Record<RoleKey, number>;
  tr: number;
  mean_confidence: number;
  uncertainty: number;
  distinct_people: number;
  missing_roles: RoleLabel[];
  blocked_sparks: Array<{ role: RoleLabel; spark_ids: string[] }>;
  model_version: string;
}

export class UnknownTargetProfileError extends Error {
  readonly code = 'unknown_target_profile';
  constructor(profile: string) {
    super(`unknown readiness target profile: ${profile}`);
  }
}

export function targetsFor(place: Place, cfg: ResolvedConfig): RoleTargets {
  const t = cfg.readiness_targets[place.target_profile];
  if (t === undefined) throw new UnknownTargetProfileError(place.target_profile);
  return t;
}

/** Whether a person counts toward role `axis` in this sector (spec 5.2 filter). */
export function countsForRole(s: SectorProfile, axis: Axis, cfg: ResolvedConfig): boolean {
  const a = s.axes[axis];
  return (
    s.roles.some((r) => r.axis === axis) &&
    a.state !== 'Dormant' &&
    a.confidence >= cfg.confidence.min_for_map_count &&
    a.verified >= cfg.roles.role_threshold
  );
}

export function computeReadiness(
  place: Place,
  sector: string,
  members: readonly PlaceMember[],
  openSparks: readonly OpenSparkCoverage[],
  cfg: ResolvedConfig,
): ReadinessCell {
  const targets = targetsFor(place, cfg);
  const counts: Record<RoleKey, number> = { partner: 0, ambassador: 0, leader: 0 };
  const confByPerson = new Map<string, number[]>();
  for (const m of members) {
    if (m.sector.sector !== sector) continue;
    for (const axis of AXES) {
      if (!countsForRole(m.sector, axis, cfg)) continue;
      counts[ROLE_KEY[axis]] += 1;
      const list = confByPerson.get(m.person_id) ?? [];
      list.push(m.sector.axes[axis].confidence);
      confByPerson.set(m.person_id, list);
    }
  }
  const hats: Record<RoleKey, number> = {
    partner: Math.min(1, counts.partner / targets.partner),
    ambassador: Math.min(1, counts.ambassador / targets.ambassador),
    leader: Math.min(1, counts.leader / targets.leader),
  };
  const tr = 100 * Math.cbrt(hats.partner * hats.ambassador * hats.leader);
  // Mean over distinct counted people; a two-role person contributes their mean confidence once.
  const perPerson = [...confByPerson.values()].map((l) => l.reduce((x, y) => x + y, 0) / l.length);
  const mean_confidence = perPerson.length === 0 ? 0 : perPerson.reduce((x, y) => x + y, 0) / perPerson.length;

  const missing_roles = AXES.filter((a) => hats[ROLE_KEY[a]] < 1)
    .sort((x, y) => hats[ROLE_KEY[x]] - hats[ROLE_KEY[y]] || AXES.indexOf(x) - AXES.indexOf(y))
    .map((a) => ROLE_LABEL[a]);

  const blocked_sparks = AXES.map((axis) => ({
    role: ROLE_LABEL[axis],
    spark_ids: openSparks
      .filter((s) => s.roles_without_candidate.includes(axis))
      .map((s) => s.spark_id)
      .sort(),
  })).filter((b) => b.spark_ids.length > 0);

  return {
    place_id: place.id,
    sector,
    counts,
    hats,
    tr,
    mean_confidence,
    uncertainty: (1 - mean_confidence) * tr,
    distinct_people: confByPerson.size,
    missing_roles,
    blocked_sparks,
    model_version: cfg.model_version,
  };
}

// ---------------------------------------------------------------------------
// Public (k-anonymous) form
// ---------------------------------------------------------------------------

export interface PublicReadinessCell {
  place_id: string;
  place_name: string;
  sector: string;
  role_counts: Record<RoleKey, BandedCount>;
  /** Exact TR only when every role count is >= k_min; otherwise null and `tr_band` is set. */
  tr: number | null;
  tr_band: string | null;
  uncertainty: number | null;
  /** True when fewer than k_min distinct verified people are counted in the cell. */
  low_population: boolean;
  missing_roles: RoleLabel[];
  blocked_sparks: Array<{ role: RoleLabel; spark_ids: string[] }>;
  model_version: string;
}

const TR_BANDS: ReadonlyArray<[number, string]> = [
  [25, '0-25'],
  [50, '25-50'],
  [75, '50-75'],
  [Number.POSITIVE_INFINITY, '75-100'],
];

export function trBand(tr: number): string {
  for (const [upper, label] of TR_BANDS) if (tr < upper) return label;
  return '75-100';
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

/**
 * The only form of a readiness cell that leaves the engine. A cell's public form depends on that
 * cell alone and carries no cross-cell totals, so combining responses across filters (sector,
 * instance) cannot difference a sub-k count out of them.
 */
export function publishReadiness(cell: ReadinessCell, place: Place, cfg: ResolvedConfig): PublicReadinessCell {
  const k = cfg.privacy.k_min;
  const role_counts: Record<RoleKey, BandedCount> = {
    partner: bandCount(cell.counts.partner, k),
    ambassador: bandCount(cell.counts.ambassador, k),
    leader: bandCount(cell.counts.leader, k),
  };
  const exact = Object.values(role_counts).every((b) => b.kind === 'count');
  return {
    place_id: cell.place_id,
    place_name: place.name,
    sector: cell.sector,
    role_counts,
    tr: exact ? round1(cell.tr) : null,
    tr_band: exact ? null : trBand(cell.tr),
    uncertainty: exact ? round1(cell.uncertainty) : null,
    low_population: cell.distinct_people < k,
    missing_roles: cell.missing_roles,
    blocked_sparks: cell.blocked_sparks,
    model_version: cell.model_version,
  };
}

export interface MapQuery {
  sector?: string;
}

/** Build the public map for one instance: one cell per (place, sector), nothing aggregated. */
export function buildPublicMap(
  places: readonly Place[],
  membersByPlace: ReadonlyMap<string, readonly { person_id: string; sectors: readonly SectorProfile[] }[]>,
  sparksByCell: ReadonlyMap<string, readonly OpenSparkCoverage[]>,
  cfg: ResolvedConfig,
  query: MapQuery = {},
): PublicReadinessCell[] {
  const sectors = query.sector === undefined ? cfg.sectors : cfg.sectors.filter((s) => s === query.sector);
  const out: PublicReadinessCell[] = [];
  for (const place of places) {
    if (place.instance_id !== cfg.instance.id) continue;
    const people = membersByPlace.get(place.id) ?? [];
    for (const sector of sectors) {
      const members: PlaceMember[] = [];
      for (const p of people) {
        const s = p.sectors.find((x) => x.sector === sector);
        if (s !== undefined) members.push({ person_id: p.person_id, sector: s });
      }
      const cell = computeReadiness(place, sector, members, sparksByCell.get(cellKey(place.id, sector)) ?? [], cfg);
      out.push(publishReadiness(cell, place, cfg));
    }
  }
  return out;
}

export function cellKey(placeId: string, sector: string): string {
  return `${placeId}:${sector}`;
}
