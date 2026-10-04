// Deterministic synthetic data for the evaluation harness. Fake people only: members are ids
// ("syn-…"), never names. Real place names come from fixtures/places.json (spec §6).

import { AXES } from '../../packages/pal-core/src/config.ts';
import type { Axis, PalConfig } from '../../packages/pal-core/src/config.ts';
import type { ClaimedItem, VerifiedEvidence } from '../../packages/pal-core/src/scoring.ts';
import type { DateWindow } from '../../packages/pal-core/src/matching.ts';
import type { Place } from '../../packages/pal-core/src/readiness.ts';
import type { VerifierAssignment } from '../../packages/pal-core/src/sparks.ts';
import { MS_PER_DAY, MS_PER_MONTH } from '../../packages/pal-core/src/scoring.ts';
import { Rng } from './rng.ts';

export interface Fixtures {
  places: Place[];
  parents: Place[];
  sector_vocabulary: Record<string, string[]>;
}

export type Footprint = 'low' | 'high';
export type SelfReportedGender = 'woman' | 'man' | 'nonbinary' | null;

export interface LatentRole {
  sector: string;
  axis: Axis;
  /** 0..1: how active this person truly is in this role. Hidden from the engine. */
  activity: number;
}

export interface SyntheticMember {
  person_id: string;
  instance_id: string;
  place_id: string;
  cluster_key: string | null;
  /** Social/digital footprint size: drives claimed signals only. */
  footprint: Footprint;
  /** Optional self-report, used only by the fairness audit; never an engine input. */
  gender: SelfReportedGender;
  latent: LatentRole[];
  /** Simulated verifier ground truth per sector: the role a verifier would confirm, or none. */
  verifier_label: Record<string, Axis | 'none'>;
  evidence: VerifiedEvidence[];
  claimed: ClaimedItem[];
  offers_text: string;
  availability: DateWindow[];
}

export interface SparkSeed {
  spark_id: string;
  instance_id: string;
  place_id: string;
  sector: string;
  duration_days: number;
  start: string;
  text: string;
}

export interface SyntheticDataset {
  seed: number;
  now: string;
  places: Place[];
  parents: Place[];
  members: SyntheticMember[];
  verifier_assignments: VerifierAssignment[];
  sparks: SparkSeed[];
}

export interface GenerateOptions {
  seed: number;
  now: string;
  members_per_place: number;
  months_of_history: number;
  /** 0 = footprint independent of true activity (default). >0 injects bias, for audit tests. */
  footprint_activity_correlation: number;
  sparks_per_place: number;
}

export const DEFAULT_GENERATE_OPTIONS: GenerateOptions = {
  seed: 20261004,
  now: '2026-10-01T00:00:00.000Z',
  members_per_place: 80,
  months_of_history: 36,
  footprint_activity_correlation: 0,
  sparks_per_place: 2,
};

const VERIFICATION_MIX: ReadonlyArray<[VerifiedEvidence['verification_level'], number]> = [
  ['verified', 0.7],
  ['corroborated', 0.15],
  ['unverified', 0.15],
];

function verificationLevel(rng: Rng): VerifiedEvidence['verification_level'] {
  let r = rng.next();
  for (const [lvl, p] of VERIFICATION_MIX) {
    if (r < p) return lvl;
    r -= p;
  }
  return 'verified';
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function generateDataset(config: PalConfig, fixtures: Fixtures, opts: GenerateOptions = DEFAULT_GENERATE_OPTIONS): SyntheticDataset {
  const root = new Rng(opts.seed);
  const nowMs = Date.parse(opts.now);
  const instances = new Map(config.instances.map((i) => [i.id, i]));
  const members: SyntheticMember[] = [];
  const assignments: VerifierAssignment[] = [];
  const sparks: SparkSeed[] = [];
  const sectors = config.sectors;

  for (const place of fixtures.places) {
    const inst = instances.get(place.instance_id);
    if (inst === undefined) continue; // fixture for an instance not configured: skip
    const rng = root.fork(place.id);
    const orgs = Array.from({ length: 8 }, (_, i) => `${place.id}-org-${i + 1}`);
    const verifiers = Array.from({ length: rng.int(2, 4) }, (_, i) => `${place.id}-verifier-${i + 1}`);
    for (const v of verifiers) {
      assignments.push({ verifier_id: v, place_id: place.id, active_from: iso(nowMs - 400 * MS_PER_DAY), active_to: null });
    }
    // Place-level sector emphasis so places differ.
    const sectorWeights = sectors.map(() => rng.uniform(0.3, 1));
    const pickSector = (): string => {
      const total = sectorWeights.reduce((a, b) => a + b, 0);
      let r = rng.next() * total;
      for (let i = 0; i < sectors.length; i++) {
        r -= sectorWeights[i] as number;
        if (r <= 0) return sectors[i] as string;
      }
      return sectors[sectors.length - 1] as string;
    };

    for (let n = 0; n < opts.members_per_place; n++) {
      const person_id = `syn-${place.id}-${String(n + 1).padStart(4, '0')}`;
      const nRoles = rng.bool(0.25) ? 2 : 1;
      const latent: LatentRole[] = [];
      for (let r = 0; r < nRoles; r++) {
        const sector = pickSector();
        if (latent.some((l) => l.sector === sector)) continue;
        latent.push({ sector, axis: rng.pick(AXES), activity: Math.pow(rng.next(), 1.4) });
      }
      const maxActivity = Math.max(...latent.map((l) => l.activity));
      const pHigh = Math.min(1, Math.max(0, 0.5 + opts.footprint_activity_correlation * (maxActivity - 0.5)));
      const footprint: Footprint = rng.bool(pHigh) ? 'high' : 'low';
      const genderRoll = rng.next();
      const gender: SelfReportedGender = genderRoll < 0.35 ? 'woman' : genderRoll < 0.7 ? 'man' : genderRoll < 0.73 ? 'nonbinary' : null;

      const evidence: VerifiedEvidence[] = [];
      let evSeq = 0;
      const addEvents = (sector: string, axis: Axis, count: number): void => {
        const types = Object.keys(config.scoring.evidence_weights[axis]);
        for (let i = 0; i < count; i++) {
          evSeq += 1;
          const ageMs = rng.next() * opts.months_of_history * MS_PER_MONTH;
          evidence.push({
            id: `${person_id}:ev:${evSeq}`,
            axis,
            sector,
            evidence_type: rng.pick(types),
            quality: rng.bool(0.2) ? null : Math.round(rng.uniform(0.6, 1) * 100) / 100,
            verification_level: verificationLevel(rng),
            occurred_at: iso(nowMs - ageMs),
            verifier_id: rng.pick(verifiers),
            source_ref: `eco_events:${person_id}:${evSeq}`,
          });
        }
      };
      for (const l of latent) {
        addEvents(l.sector, l.axis, rng.poisson(l.activity * 14));
        for (const other of AXES) if (other !== l.axis) addEvents(l.sector, other, rng.poisson(0.6));
      }

      const claimed: ClaimedItem[] = [];
      const nClaims = footprint === 'high' ? rng.int(6, 15) : rng.int(0, 3);
      const vocabWords: string[] = [];
      for (let i = 0; i < nClaims; i++) {
        const l = rng.pick(latent);
        const sector = rng.bool(0.8) ? l.sector : rng.pick(sectors);
        const axis = rng.bool(0.6) ? l.axis : rng.pick(AXES);
        const word = rng.pick(fixtures.sector_vocabulary[sector] ?? [sector]);
        vocabWords.push(word);
        const language = rng.pick(inst.languages);
        claimed.push({
          id: `${person_id}:cl:${i + 1}`,
          axis: rng.bool(0.85) ? axis : null,
          sector,
          feature_type: rng.pick(['offer', 'sector_interest', 'community_role', 'need'] as const),
          value: `${word} ${rng.int(1, 6)}`,
          weight: config.extraction.validated_languages.includes(language) ? 1 : config.extraction.unvalidated_language_weight,
          evidence_ref: `post:${person_id}:${i + 1}`,
        });
      }
      for (const l of latent) {
        const vocab = fixtures.sector_vocabulary[l.sector] ?? [];
        for (let i = 0; i < 3; i++) vocabWords.push(rng.pick(vocab));
      }

      const verifier_label: Record<string, Axis | 'none'> = {};
      for (const l of latent) {
        let label: Axis | 'none' = l.activity >= 0.35 ? l.axis : 'none';
        if (rng.bool(0.1)) label = rng.pick([...AXES, 'none'] as const);
        verifier_label[l.sector] = label;
      }

      const availability: DateWindow[] = [];
      if (rng.bool(0.8)) {
        const start = nowMs + rng.int(-10, 20) * MS_PER_DAY;
        availability.push({ start: iso(start), end: iso(start + rng.int(10, 60) * MS_PER_DAY) });
      }

      members.push({
        person_id,
        instance_id: place.instance_id,
        place_id: place.id,
        cluster_key: rng.bool(0.85) ? rng.pick(orgs) : null,
        footprint,
        gender,
        latent,
        verifier_label,
        evidence,
        claimed,
        offers_text: vocabWords.join(' '),
        availability,
      });
    }

    const used = new Set<string>();
    for (let s = 0; s < opts.sparks_per_place; s++) {
      let sector = pickSector();
      for (let tries = 0; used.has(sector) && tries < 10; tries++) sector = pickSector();
      used.add(sector);
      const vocab = fixtures.sector_vocabulary[sector] ?? [sector];
      sparks.push({
        spark_id: `spark-${place.id}-${s + 1}`,
        instance_id: place.instance_id,
        place_id: place.id,
        sector,
        duration_days: rng.pick(config.sparks.durations_days),
        start: iso(nowMs + 7 * MS_PER_DAY),
        text: rng.shuffle(vocab).slice(0, 4).join(' '),
      });
    }
  }

  return {
    seed: opts.seed,
    now: opts.now,
    places: fixtures.places.filter((p) => instances.has(p.instance_id)),
    parents: fixtures.parents,
    members,
    verifier_assignments: assignments,
    sparks,
  };
}
