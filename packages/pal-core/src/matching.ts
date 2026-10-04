// Trio matching for Sparks (spec 5.3): exactly one Partner, one Ambassador, one Leader.
//
//   fit          = 0.5 * cosine(brief, person offers/needs) + 0.5 * B(axis, sector) / 100
//   trust        = confidence(axis, sector) * V(axis, sector) / 100
//   availability = share of the Spark window covered by the person's declared windows
//   diversity    = (distinct clusters - 1) / 2      (cluster = organisation/community until Stage B)
//   trio score   = w.fit*mean(fit) + w.trust*mean(trust) + w.availability*mean(avail) + w.diversity*diversity

import { AXES, ROLE_LABEL } from './config.ts';
import type { Axis, ResolvedConfig, RoleLabel } from './config.ts';
import type { EvidenceLine, SectorProfile } from './scoring.ts';
import { MS_PER_DAY } from './scoring.ts';

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

export interface Embedder {
  readonly id: string;
  embed(texts: readonly string[]): Promise<number[][]>;
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic hashed bag-of-words embedder for tests and the eval harness. Not semantic. */
export class FakeEmbedder implements Embedder {
  readonly id: string;
  private readonly dims: number;
  constructor(dims = 64) {
    this.dims = dims;
    this.id = `fake-bow-${dims}`;
  }
  embedSync(text: string): number[] {
    const v = new Array<number>(this.dims).fill(0);
    for (const tok of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if (tok.length < 2) continue;
      const h = fnv1a(tok);
      v[h % this.dims] = (v[h % this.dims] as number) + ((h >>> 16) & 1 ? 1 : -1);
    }
    return v;
  }
  embed(texts: readonly string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((t) => this.embedSync(t)));
  }
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface DateWindow {
  start: string;
  end: string;
}

export interface SparkBrief {
  spark_id: string;
  place_id: string;
  sector: string;
  duration_days: number;
  window: DateWindow;
  text: string;
  embedding: readonly number[];
}

export interface MatchCandidate {
  person_id: string;
  /** Declared organisation/community (Stage A cluster). Null: the person is their own cluster. */
  cluster_key: string | null;
  sector_profile: SectorProfile;
  /** Embedding of the person's offers/needs text. */
  embedding: readonly number[];
  availability: readonly DateWindow[];
  consent_active: boolean;
  /** Axes (in this sector) that have evidence under an open dispute. */
  disputed_axes: readonly Axis[];
  /** Spark ids or person ids the person has declared a conflict with. */
  conflicts: readonly string[];
  /** Counted evidence lines, used for explanations only. */
  evidence_lines: readonly EvidenceLine[];
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export interface DrivingSignal {
  evidence_id: string;
  type: string;
  /** Always explicit: claimed signals are never presented as verified. */
  basis: 'verified' | 'claimed';
  points: number;
}

export interface MemberExplanation {
  person_id: string;
  role: RoleLabel;
  axis: Axis;
  cluster: string;
  verified_score: number;
  claimed_score: number;
  match_score: number;
  confidence: number;
  components: { fit: number; similarity: number; trust: number; availability: number };
  trust_drivers: DrivingSignal[];
  fit_drivers: DrivingSignal[];
  notes: string[];
}

export interface TrioProposal {
  rank: number;
  score: number;
  diversity: number;
  distinct_clusters: number;
  members: [MemberExplanation, MemberExplanation, MemberExplanation];
}

export type ExclusionReason = 'consent_revoked' | 'open_dispute' | 'declared_conflict' | 'no_signal_on_axis';

export interface MatchResult {
  spark_id: string;
  trios: TrioProposal[];
  /** Roles with no eligible candidate (feeds readiness blocked_sparks). */
  roles_without_candidate: Axis[];
  /** Counts only (per person, or per person and role for open_dispute / no_signal_on_axis). */
  excluded: Record<ExclusionReason, number>;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export function availabilityOverlap(windows: readonly DateWindow[], spark: DateWindow): number {
  const s = Date.parse(spark.start);
  const e = Date.parse(spark.end);
  if (!(e > s)) return 0;
  // Union of declared windows clipped to the spark window, at day granularity.
  const ranges = windows
    .map((w) => [Math.max(s, Date.parse(w.start)), Math.min(e, Date.parse(w.end))] as const)
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let covered = 0;
  let curA = -Infinity;
  let curB = -Infinity;
  for (const [a, b] of ranges) {
    if (a > curB) {
      if (curB > curA) covered += curB - curA;
      curA = a;
      curB = b;
    } else curB = Math.max(curB, b);
  }
  if (curB > curA) covered += curB - curA;
  return Math.min(1, covered / (e - s));
}

export function sparkWindow(start: string, durationDays: number): DateWindow {
  return { start, end: new Date(Date.parse(start) + durationDays * MS_PER_DAY).toISOString() };
}

interface RoleCandidate {
  c: MatchCandidate;
  axis: Axis;
  fit: number;
  similarity: number;
  trust: number;
  availability: number;
  partial: number;
}

function scoreForRole(c: MatchCandidate, axis: Axis, brief: SparkBrief, cfg: ResolvedConfig): RoleCandidate {
  const a = c.sector_profile.axes[axis];
  const similarity = Math.max(0, cosine(brief.embedding, c.embedding));
  const fit = 0.5 * similarity + 0.5 * (a.match / 100);
  const trust = a.confidence * (a.verified / 100);
  const availability = availabilityOverlap(c.availability, brief.window);
  const w = cfg.matching.weights;
  return { c, axis, fit, similarity, trust, availability, partial: w.fit * fit + w.trust * trust + w.availability * availability };
}

function clusterOf(c: MatchCandidate): string {
  return c.cluster_key === null || c.cluster_key.trim() === '' ? `person:${c.person_id}` : `org:${c.cluster_key.trim().toLowerCase()}`;
}

function explain(rc: RoleCandidate): MemberExplanation {
  const a = rc.c.sector_profile.axes[rc.axis];
  const sector = rc.c.sector_profile.sector;
  const relevant = rc.c.evidence_lines.filter((l) => l.status === 'counted' && l.axis === rc.axis && l.sector === sector);
  const toSignal = (l: EvidenceLine): DrivingSignal => ({
    evidence_id: l.id,
    type: l.type,
    basis: l.kind === 'verified' ? 'verified' : 'claimed',
    points: Math.round(l.points * 100) / 100,
  });
  const notes: string[] = [];
  if (a.verified === 0) notes.push('No verified evidence on this axis: match relies on claimed signals only.');
  if (rc.availability === 0) notes.push('No declared availability overlaps the Spark window.');
  return {
    person_id: rc.c.person_id,
    role: ROLE_LABEL[rc.axis],
    axis: rc.axis,
    cluster: clusterOf(rc.c),
    verified_score: a.verified,
    claimed_score: a.claimed,
    match_score: a.match,
    confidence: a.confidence,
    components: { fit: rc.fit, similarity: rc.similarity, trust: rc.trust, availability: rc.availability },
    // Trust is driven only by verified evidence, by construction.
    trust_drivers: relevant.filter((l) => l.kind === 'verified').sort((x, y) => y.points - x.points).slice(0, 5).map(toSignal),
    fit_drivers: relevant.filter((l) => l.kind === 'claimed').sort((x, y) => y.points - x.points).slice(0, 5).map(toSignal),
    notes,
  };
}

/** Propose up to max_trios trios. Pure and deterministic for a given input order. */
export function proposeTrios(brief: SparkBrief, candidates: readonly MatchCandidate[], cfg: ResolvedConfig): MatchResult {
  const excluded: Record<ExclusionReason, number> = {
    consent_revoked: 0,
    open_dispute: 0,
    declared_conflict: 0,
    no_signal_on_axis: 0,
  };
  const eligiblePeople: MatchCandidate[] = [];
  for (const c of candidates) {
    if (c.sector_profile.sector !== brief.sector) continue;
    if (!c.consent_active) excluded.consent_revoked += 1;
    else if (c.conflicts.includes(brief.spark_id)) excluded.declared_conflict += 1;
    else eligiblePeople.push(c);
  }

  const perRole = new Map<Axis, RoleCandidate[]>();
  for (const axis of AXES) {
    const list: RoleCandidate[] = [];
    for (const c of eligiblePeople) {
      if (c.disputed_axes.includes(axis)) {
        excluded.open_dispute += 1;
        continue;
      }
      if (c.sector_profile.axes[axis].match <= 0) {
        excluded.no_signal_on_axis += 1;
        continue;
      }
      list.push(scoreForRole(c, axis, brief, cfg));
    }
    list.sort((x, y) => y.partial - x.partial || (x.c.person_id < y.c.person_id ? -1 : 1));
    perRole.set(axis, list.slice(0, cfg.matching.candidates_per_role));
  }
  const roles_without_candidate = AXES.filter((a) => (perRole.get(a) ?? []).length === 0);

  const P = perRole.get('capital') ?? [];
  const A = perRole.get('vision') ?? [];
  const L = perRole.get('execution') ?? [];
  const w = cfg.matching.weights;
  const scored: Array<{ score: number; diversity: number; clusters: number; m: [RoleCandidate, RoleCandidate, RoleCandidate] }> = [];
  for (const p of P) {
    for (const a of A) {
      if (a.c.person_id === p.c.person_id) continue;
      if (p.c.conflicts.includes(a.c.person_id) || a.c.conflicts.includes(p.c.person_id)) continue;
      for (const l of L) {
        if (l.c.person_id === p.c.person_id || l.c.person_id === a.c.person_id) continue;
        const ids = [p.c.person_id, a.c.person_id, l.c.person_id];
        if ([p, a, l].some((x) => x.c.conflicts.some((cf) => ids.includes(cf)))) continue;
        const clusters = new Set([clusterOf(p.c), clusterOf(a.c), clusterOf(l.c)]).size;
        if (clusters < cfg.matching.min_distinct_clusters) continue;
        const diversity = (clusters - 1) / 2;
        const mean = (f: (x: RoleCandidate) => number) => (f(p) + f(a) + f(l)) / 3;
        const score =
          w.fit * mean((x) => x.fit) +
          w.trust * mean((x) => x.trust) +
          w.availability * mean((x) => x.availability) +
          w.diversity * diversity;
        scored.push({ score, diversity, clusters, m: [p, a, l] });
      }
    }
  }
  scored.sort((x, y) => y.score - x.score || x.m.map((r) => r.c.person_id).join().localeCompare(y.m.map((r) => r.c.person_id).join()));

  const trios: TrioProposal[] = scored.slice(0, cfg.matching.max_trios).map((t, i) => ({
    rank: i + 1,
    score: t.score,
    diversity: t.diversity,
    distinct_clusters: t.clusters,
    members: [explain(t.m[0]), explain(t.m[1]), explain(t.m[2])],
  }));
  return { spark_id: brief.spark_id, trios, roles_without_candidate, excluded };
}
