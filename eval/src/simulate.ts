// Runs the real pal-core pipeline over a synthetic dataset: profiles (with a 120-day history
// snapshot), readiness, public map, matching, a random-matching baseline and simulated outcomes.

import { AXES, resolveInstanceConfig } from '../../packages/pal-core/src/config.ts';
import type { Axis, PalConfig, ResolvedConfig } from '../../packages/pal-core/src/config.ts';
import { computeProfile, historyPoint, MS_PER_DAY } from '../../packages/pal-core/src/scoring.ts';
import type { PersonProfile, SectorProfile } from '../../packages/pal-core/src/scoring.ts';
import { buildPublicMap, cellKey, computeReadiness } from '../../packages/pal-core/src/readiness.ts';
import type { OpenSparkCoverage, PlaceMember, PublicReadinessCell, ReadinessCell } from '../../packages/pal-core/src/readiness.ts';
import { availabilityOverlap, FakeEmbedder, proposeTrios, sparkWindow } from '../../packages/pal-core/src/matching.ts';
import type { MatchCandidate, MatchResult, SparkBrief } from '../../packages/pal-core/src/matching.ts';
import { countActiveVerifiers } from '../../packages/pal-core/src/sparks.ts';
import type { SparkSeed, SyntheticDataset, SyntheticMember } from './generate.ts';
import { Rng } from './rng.ts';

export interface ProfiledMember {
  member: SyntheticMember;
  profile: PersonProfile;
}

export interface SparkRun {
  seed: SparkSeed;
  result: MatchResult;
  active_verifiers: number;
  /** Expected completion probability of the top proposed trio (simulated ground truth). */
  p_top: number | null;
  /** Mean expected completion probability of random valid trios. */
  p_random: number | null;
  /** Simulated outcome of running the top trio (for spark_outcomes / Stage C export). */
  completed: boolean | null;
}

export interface InstanceRun {
  instance_id: string;
  cfg: ResolvedConfig;
  members: ProfiledMember[];
  cells: ReadinessCell[];
  cells_later: ReadinessCell[];
  public_map: PublicReadinessCell[];
  sparks: SparkRun[];
}

export interface SimulationRun {
  dataset: SyntheticDataset;
  instances: InstanceRun[];
}

const embedder = new FakeEmbedder(64);

export function profileMember(m: SyntheticMember, cfg: ResolvedConfig, now: string): PersonProfile {
  const past = new Date(Date.parse(now) - 120 * MS_PER_DAY).toISOString();
  const base = { person_id: m.person_id, evidence: m.evidence, claimed: m.claimed, frozen_ids: new Set<string>() };
  const earlier = computeProfile({ ...base, history: [], now: past }, cfg);
  return computeProfile({ ...base, history: [historyPoint(earlier)], now }, cfg);
}

function sectorOf(p: PersonProfile, sector: string): SectorProfile | undefined {
  return p.sectors.find((s) => s.sector === sector);
}

function cellsFor(cfg: ResolvedConfig, ds: SyntheticDataset, members: ProfiledMember[], coverage: Map<string, OpenSparkCoverage[]>): ReadinessCell[] {
  const out: ReadinessCell[] = [];
  for (const place of ds.places.filter((p) => p.instance_id === cfg.instance.id)) {
    const inPlace = members.filter((m) => m.member.place_id === place.id);
    for (const sector of cfg.sectors) {
      const pm: PlaceMember[] = [];
      for (const m of inPlace) {
        const s = sectorOf(m.profile, sector);
        if (s !== undefined) pm.push({ person_id: m.member.person_id, sector: s });
      }
      out.push(computeReadiness(place, sector, pm, coverage.get(cellKey(place.id, sector)) ?? [], cfg));
    }
  }
  return out;
}

/** Simulated ground truth: how well a person truly fits a role (hidden from the engine). */
export function trueFit(m: SyntheticMember, sector: string, axis: Axis): number {
  const l = m.latent.find((x) => x.sector === sector && x.axis === axis);
  return l === undefined ? 0.05 : l.activity;
}

export function completionProbability(trio: readonly SyntheticMember[], axes: readonly Axis[], seed: SparkSeed): number {
  const window = sparkWindow(seed.start, seed.duration_days);
  const fit = trio.reduce((s, m, i) => s + trueFit(m, seed.sector, axes[i] as Axis), 0) / trio.length;
  const avail = trio.reduce((s, m) => s + availabilityOverlap(m.availability, window), 0) / trio.length;
  const clusters = new Set(trio.map((m) => m.cluster_key ?? m.person_id)).size;
  return Math.min(1, 0.15 + 0.6 * fit + 0.1 * ((clusters - 1) / 2) + 0.15 * avail);
}

function candidatesFor(members: ProfiledMember[], seed: SparkSeed): MatchCandidate[] {
  const out: MatchCandidate[] = [];
  for (const m of members) {
    if (m.member.place_id !== seed.place_id) continue;
    const s = sectorOf(m.profile, seed.sector);
    if (s === undefined) continue;
    out.push({
      person_id: m.member.person_id,
      cluster_key: m.member.cluster_key,
      sector_profile: s,
      embedding: embedder.embedSync(m.member.offers_text),
      availability: m.member.availability,
      consent_active: true,
      disputed_axes: [],
      conflicts: [],
      evidence_lines: m.profile.evidence_lines,
    });
  }
  return out;
}

function randomBaseline(cands: MatchCandidate[], byId: Map<string, SyntheticMember>, seed: SparkSeed, rng: Rng, draws: number): number | null {
  const pools = AXES.map((a) => cands.filter((c) => c.sector_profile.axes[a].match > 0));
  if (pools.some((p) => p.length === 0)) return null;
  let total = 0;
  let n = 0;
  for (let d = 0; d < draws * 5 && n < draws; d++) {
    const pick = pools.map((p) => rng.pick(p));
    if (new Set(pick.map((c) => c.person_id)).size < 3) continue;
    total += completionProbability(pick.map((c) => byId.get(c.person_id) as SyntheticMember), AXES, seed);
    n += 1;
  }
  return n === 0 ? null : total / n;
}

export function simulate(config: PalConfig, ds: SyntheticDataset): SimulationRun {
  const rng = new Rng(ds.seed ^ 0x5eed);
  const instances: InstanceRun[] = [];
  for (const inst of config.instances) {
    const cfg = resolveInstanceConfig(config, inst.id);
    const members = ds.members
      .filter((m) => m.instance_id === inst.id)
      .map((member) => ({ member, profile: profileMember(member, cfg, ds.now) }));
    const byId = new Map(members.map((m) => [m.member.person_id, m.member]));

    const sparks: SparkRun[] = [];
    const coverage = new Map<string, OpenSparkCoverage[]>();
    for (const seed of ds.sparks.filter((s) => s.instance_id === inst.id)) {
      const cands = candidatesFor(members, seed);
      const brief: SparkBrief = {
        spark_id: seed.spark_id,
        place_id: seed.place_id,
        sector: seed.sector,
        duration_days: seed.duration_days,
        window: sparkWindow(seed.start, seed.duration_days),
        text: seed.text,
        embedding: embedder.embedSync(seed.text),
      };
      const result = proposeTrios(brief, cands, cfg);
      const key = cellKey(seed.place_id, seed.sector);
      coverage.set(key, [...(coverage.get(key) ?? []), { spark_id: seed.spark_id, roles_without_candidate: result.roles_without_candidate }]);
      const place = ds.places.find((p) => p.id === seed.place_id);
      const chain = place === undefined ? [] : [place.id, ...(place.parent_id === null ? [] : [place.parent_id])];
      const top = result.trios[0];
      const p_top = top === undefined ? null : completionProbability(top.members.map((x) => byId.get(x.person_id) as SyntheticMember), AXES, seed);
      sparks.push({
        seed,
        result,
        active_verifiers: countActiveVerifiers(ds.verifier_assignments, chain, ds.now),
        p_top,
        p_random: randomBaseline(cands, byId, seed, rng, 200),
        completed: p_top === null ? null : rng.bool(p_top),
      });
    }

    const later = new Date(Date.parse(ds.now) + 30 * MS_PER_DAY).toISOString();
    const membersLater = members.map((m) => ({ member: m.member, profile: profileMember(m.member, cfg, later) }));
    const byPlace = new Map<string, Array<{ person_id: string; sectors: SectorProfile[] }>>();
    for (const m of members) {
      const list = byPlace.get(m.member.place_id) ?? [];
      list.push({ person_id: m.member.person_id, sectors: m.profile.sectors });
      byPlace.set(m.member.place_id, list);
    }
    instances.push({
      instance_id: inst.id,
      cfg,
      members,
      cells: cellsFor(cfg, ds, members, coverage),
      cells_later: cellsFor(cfg, ds, membersLater, coverage),
      public_map: buildPublicMap(ds.places, byPlace, coverage, cfg),
      sparks,
    });
  }
  return { dataset: ds, instances };
}
