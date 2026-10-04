import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availabilityOverlap, cosine, FakeEmbedder, proposeTrios, sparkWindow } from '../src/matching.ts';
import type { MatchCandidate, SparkBrief } from '../src/matching.ts';
import { computeProfile } from '../src/scoring.ts';
import type { ClaimedItem, VerifiedEvidence } from '../src/scoring.ts';
import type { Axis } from '../src/config.ts';
import { cfg, daysBefore, ev, NOW } from './helpers.ts';

const emb = new FakeEmbedder(64);
const c = cfg();
const TYPE: Record<Axis, string> = { capital: 'pool_contribution', vision: 'referral_active', execution: 'sprint_closed_verified' };
const window = sparkWindow('2026-10-10T00:00:00.000Z', 14);

const brief: SparkBrief = {
  spark_id: 'spark-1',
  place_id: 'pl-1',
  sector: 'agriculture',
  duration_days: 14,
  window,
  text: 'drip irrigation for smallholder farmers market access',
  embedding: emb.embedSync('drip irrigation for smallholder farmers market access'),
};

function person(
  id: string,
  org: string | null,
  verified: Partial<Record<Axis, number>>,
  over: Partial<MatchCandidate> & { claimed?: ClaimedItem[]; text?: string } = {},
): MatchCandidate {
  const evidence: VerifiedEvidence[] = [];
  for (const [axis, n] of Object.entries(verified) as Array<[Axis, number]>) {
    for (let i = 0; i < n; i++) evidence.push(ev({ id: `${id}-${axis}-${i}`, axis, evidence_type: TYPE[axis], verifier_id: `v${i % 2}` }));
  }
  const profile = computeProfile(
    { person_id: id, evidence, claimed: over.claimed ?? [], frozen_ids: new Set(), history: [], now: NOW },
    c,
  );
  const sector = profile.sectors.find((s) => s.sector === 'agriculture');
  assert.ok(sector, `${id} has no agriculture profile`);
  return {
    person_id: id,
    cluster_key: org,
    sector_profile: sector,
    embedding: emb.embedSync(over.text ?? 'farmers irrigation'),
    availability: [{ start: daysBefore(window.start, 5), end: window.end }],
    consent_active: true,
    disputed_axes: [],
    conflicts: [],
    evidence_lines: profile.evidence_lines,
    ...over,
  };
}

function claimedItem(id: string, axis: Axis): ClaimedItem {
  return { id, axis, sector: 'agriculture', feature_type: 'offer', value: id, weight: 1, evidence_ref: `post:${id}` };
}

function pool(): MatchCandidate[] {
  return [
    person('cap1', 'Org A', { capital: 5 }),
    person('cap2', 'Org B', { capital: 3 }),
    person('amb1', 'Org A', { vision: 6 }),
    person('amb2', 'Org C', { vision: 4 }),
    person('lead1', 'Org A', { execution: 6 }),
    person('lead2', 'org b ', { execution: 4 }), // same cluster as Org B after normalisation
    person('claimer', 'Org D', {}, { claimed: [1, 2, 3, 4, 5].map((i) => claimedItem(`cl${i}`, 'capital')) }),
    person('revoked', 'Org E', { capital: 9 }, { consent_active: false }),
    person('disputed', 'Org F', { capital: 9 }, { disputed_axes: ['capital'] }),
    person('conflicted', 'Org G', { capital: 9 }, { conflicts: ['spark-1'] }),
  ];
}

test('MATCH: exactly one P, A, L; no duplicate person; >= min clusters; explanations mark basis', () => {
  const r = proposeTrios(brief, pool(), c);
  assert.equal(r.trios.length, c.matching.max_trios);
  for (const t of r.trios) {
    assert.deepEqual(t.members.map((m) => m.role), ['Partner', 'Ambassador', 'Leader']);
    assert.equal(new Set(t.members.map((m) => m.person_id)).size, 3);
    assert.ok(t.distinct_clusters >= c.matching.min_distinct_clusters);
    assert.equal(new Set(t.members.map((m) => m.cluster)).size, t.distinct_clusters);
    for (const m of t.members) {
      assert.ok(m.trust_drivers.every((d) => d.basis === 'verified'));
      assert.ok(m.fit_drivers.every((d) => d.basis === 'claimed'));
      assert.equal(typeof m.verified_score, 'number');
      assert.equal(typeof m.claimed_score, 'number');
    }
  }
  const all = r.trios.flatMap((t) => t.members.map((m) => m.person_id));
  for (const banned of ['revoked', 'disputed', 'conflicted']) assert.ok(!all.includes(banned), banned);
  assert.deepEqual(r.excluded, { consent_revoked: 1, open_dispute: 1, declared_conflict: 1, no_signal_on_axis: r.excluded.no_signal_on_axis });
  // Ranked and scored descending.
  assert.deepEqual(r.trios.map((t) => t.rank), [1, 2, 3]);
  for (let i = 1; i < r.trios.length; i++) assert.ok(r.trios[i - 1]!.score >= r.trios[i]!.score);
});

test('STINGY in matching: a claimed-only person shows V = 0 and no verified trust drivers', () => {
  // Force the claimer in by making them the only Partner candidate.
  const people = pool().filter((p) => !['cap1', 'cap2'].includes(p.person_id));
  const r = proposeTrios(brief, people, c);
  assert.ok(r.trios.length > 0);
  for (const t of r.trios) {
    const partner = t.members[0];
    assert.equal(partner.person_id, 'claimer');
    assert.equal(partner.verified_score, 0);
    assert.equal(partner.claimed_score, 25);
    assert.equal(partner.components.trust, 0);
    assert.deepEqual(partner.trust_drivers, []);
    assert.ok(partner.fit_drivers.length > 0 && partner.fit_drivers.every((d) => d.basis === 'claimed'));
    assert.ok(partner.notes.some((n) => n.includes('claimed signals only')));
  }
});

test('single-cluster pools yield no trio; empty roles are reported', () => {
  const sameOrg = [person('a', 'Org A', { capital: 4 }), person('b', 'Org A', { vision: 4 }), person('c', 'Org A', { execution: 4 })];
  assert.equal(proposeTrios(brief, sameOrg, c).trios.length, 0);
  const noLeader = [person('a', 'Org A', { capital: 4 }), person('b', 'Org B', { vision: 4 })];
  assert.deepEqual(proposeTrios(brief, noLeader, c).roles_without_candidate, ['execution']);
});

test('one person cannot fill two roles even if strong on all axes', () => {
  const people = [
    person('all', 'Org A', { capital: 6, vision: 6, execution: 6 }),
    person('p', 'Org B', { capital: 2 }),
    person('a', 'Org C', { vision: 2 }),
    person('l', 'Org D', { execution: 2 }),
  ];
  const r = proposeTrios(brief, people, cfg({ matching: { ...c.matching, max_trios: 20 } }));
  for (const t of r.trios) assert.equal(new Set(t.members.map((m) => m.person_id)).size, 3);
  assert.equal(r.trios.length, 4); // (p,a,l) plus "all" in each one of the three roles
});

test('pairwise declared conflicts between members are respected', () => {
  const people = [
    person('p', 'Org A', { capital: 4 }, { conflicts: ['a'] }),
    person('a', 'Org B', { vision: 4 }),
    person('a2', 'Org B', { vision: 1 }),
    person('l', 'Org C', { execution: 4 }),
  ];
  const r = proposeTrios(brief, people, c);
  assert.ok(r.trios.length > 0);
  for (const t of r.trios) assert.ok(!(t.members[0].person_id === 'p' && t.members[1].person_id === 'a'));
});

test('availability changes ranking; min_distinct_clusters comes from config', () => {
  const people = [
    person('p1', 'Org A', { capital: 4 }, { availability: [] }),
    person('p2', 'Org B', { capital: 4 }),
    person('a', 'Org C', { vision: 4 }),
    person('l', 'Org D', { execution: 4 }),
  ];
  assert.equal(proposeTrios(brief, people, c).trios[0]?.members[0].person_id, 'p2');
  const three = cfg({ matching: { ...c.matching, min_distinct_clusters: 3 } });
  const twoOrgs = [person('p', 'Org A', { capital: 4 }), person('a', 'Org A', { vision: 4 }), person('l', 'Org B', { execution: 4 })];
  assert.equal(proposeTrios(brief, twoOrgs, c).trios.length, 1);
  assert.equal(proposeTrios(brief, twoOrgs, three).trios.length, 0);
});

test('availability overlap and cosine helpers', () => {
  const w = { start: '2026-01-01T00:00:00Z', end: '2026-01-11T00:00:00Z' };
  assert.equal(availabilityOverlap([w], w), 1);
  assert.equal(availabilityOverlap([{ start: '2026-01-01T00:00:00Z', end: '2026-01-06T00:00:00Z' }], w), 0.5);
  assert.equal(
    availabilityOverlap(
      [
        { start: '2026-01-01T00:00:00Z', end: '2026-01-04T00:00:00Z' },
        { start: '2026-01-03T00:00:00Z', end: '2026-01-06T00:00:00Z' },
      ],
      w,
    ),
    0.5,
  );
  assert.equal(availabilityOverlap([], w), 0);
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([0, 0], [1, 0]), 0);
});

test('fake embedder is deterministic', async () => {
  const [a, b] = await emb.embed(['solar irrigation', 'solar irrigation']);
  assert.deepEqual(a, b);
  assert.ok(cosine(emb.embedSync('solar irrigation pumps'), emb.embedSync('irrigation pumps solar')) > 0.99);
});
