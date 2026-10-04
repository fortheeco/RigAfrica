import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AXES, ROLE_LABEL } from '../src/config.ts';
import type { Axis } from '../src/config.ts';
import { buildPublicMap, cellKey, computeReadiness, publishReadiness, trBand } from '../src/readiness.ts';
import type { Place, PlaceMember } from '../src/readiness.ts';
import type { AxisScore, PersonState, SectorProfile } from '../src/scoring.ts';
import { cfg } from './helpers.ts';

const place: Place = {
  id: 'pl-1',
  instance_id: 'alpha',
  name: 'Test Ward',
  place_type: 'district',
  target_profile: 'territorial_urban',
  parent_id: null,
};

function axisScore(over: Partial<AxisScore> = {}): AxisScore {
  return {
    verified: 0,
    claimed: 0,
    match: 0,
    confidence: 0,
    state: 'Emerging',
    distinct_evidence_types: 0,
    distinct_verifiers: 0,
    verified_baseline_90d: 0,
    peak_verified: 0,
    ...over,
  };
}

function sp(
  sector: string,
  role: Axis,
  o: { verified?: number; confidence?: number; state?: PersonState } = {},
): SectorProfile {
  const axes = {} as Record<Axis, AxisScore>;
  for (const a of AXES) axes[a] = axisScore();
  const v = o.verified ?? 40;
  axes[role] = axisScore({ verified: v, match: v, confidence: o.confidence ?? 0.6, state: o.state ?? 'Established' });
  return { sector, axes, roles: [{ axis: role, label: ROLE_LABEL[role], primary: true }] };
}

function members(sector: string, n: Record<Axis, number>): PlaceMember[] {
  const out: PlaceMember[] = [];
  let i = 0;
  for (const a of AXES) for (let j = 0; j < n[a]; j++) out.push({ person_id: `m${i++}`, sector: sp(sector, a) });
  return out;
}

test('TR formula and hats', () => {
  const c = cfg();
  const cell = computeReadiness(place, 'agriculture', members('agriculture', { capital: 5, vision: 5, execution: 8 }), [], c);
  assert.deepEqual(cell.counts, { partner: 5, ambassador: 5, leader: 8 });
  assert.deepEqual(cell.hats, { partner: 1, ambassador: 0.5, leader: 1 });
  assert.ok(Math.abs(cell.tr - 100 * Math.cbrt(0.5)) < 1e-9);
  assert.ok(Math.abs(cell.mean_confidence - 0.6) < 1e-12);
  assert.ok(Math.abs(cell.uncertainty - 0.4 * cell.tr) < 1e-9);
  assert.deepEqual(cell.missing_roles, ['Ambassador']);
});

test('a missing role makes TR zero; missing roles ranked by gap', () => {
  const cell = computeReadiness(place, 'agriculture', members('agriculture', { capital: 1, vision: 0, execution: 4 }), [], cfg());
  assert.equal(cell.tr, 0);
  assert.deepEqual(cell.missing_roles, ['Ambassador', 'Partner', 'Leader']);
});

test('counting filter: dormant, low-confidence, low-V and role-less people are excluded', () => {
  const c = cfg();
  const ms: PlaceMember[] = [
    { person_id: 'a', sector: sp('agriculture', 'capital') },
    { person_id: 'b', sector: sp('agriculture', 'capital', { state: 'Dormant' }) },
    { person_id: 'c', sector: sp('agriculture', 'capital', { confidence: 0.39 }) },
    { person_id: 'd', sector: sp('agriculture', 'capital', { verified: 29 }) },
    { person_id: 'e', sector: { ...sp('agriculture', 'capital'), roles: [] } },
    { person_id: 'f', sector: sp('health', 'capital') }, // other sector
  ];
  assert.equal(computeReadiness(place, 'agriculture', ms, [], c).counts.partner, 1);
});

test('blocked sparks list open briefs lacking a candidate for the role', () => {
  const cell = computeReadiness(
    place,
    'agriculture',
    [],
    [
      { spark_id: 's2', roles_without_candidate: ['execution'] },
      { spark_id: 's1', roles_without_candidate: ['execution', 'capital'] },
    ],
    cfg(),
  );
  assert.deepEqual(cell.blocked_sparks, [
    { role: 'Partner', spark_ids: ['s1'] },
    { role: 'Leader', spark_ids: ['s1', 's2'] },
  ]);
});

test('unknown target profile throws a typed error', () => {
  assert.throws(() => computeReadiness({ ...place, target_profile: 'nope' }, 'agriculture', [], [], cfg()), {
    code: 'unknown_target_profile',
  });
});

test('TR band boundaries', () => {
  assert.equal(trBand(0), '0-25');
  assert.equal(trBand(25), '25-50');
  assert.equal(trBand(74.9), '50-75');
  assert.equal(trBand(100), '75-100');
});

// ---- Acceptance: k-anonymity -----------------------------------------------------------------

/** Every number found under a key containing "count" (and every revealed BandedCount) must be >= k. */
function assertNoSubKCounts(v: unknown, k: number, path = '$'): void {
  if (Array.isArray(v)) return v.forEach((x, i) => assertNoSubKCounts(x, k, `${path}[${i}]`));
  if (typeof v !== 'object' || v === null) return;
  const o = v as Record<string, unknown>;
  if (o['kind'] === 'count') assert.ok((o['value'] as number) >= k, `${path} reveals ${String(o['value'])}`);
  for (const [key, val] of Object.entries(o)) {
    if (typeof val === 'number' && /count|total|people|members/i.test(key)) {
      assert.ok(val >= k, `${path}.${key} = ${val} < k_min`);
    }
    assertNoSubKCounts(val, k, `${path}.${key}`);
  }
}

test('K-ANON: no response reveals a count below k_min, including via differencing across sector filters', () => {
  const c = cfg();
  const k = c.privacy.k_min;
  const places: Place[] = [
    place,
    { ...place, id: 'pl-2', name: 'Busy Ward' },
    { ...place, id: 'pl-3', name: 'Other Instance Ward', instance_id: 'beta' },
  ];
  // pl-1: tiny cells. pl-2: large agriculture cell, small health cell, people spanning both.
  const byPlace = new Map<string, Array<{ person_id: string; sectors: SectorProfile[] }>>();
  byPlace.set(
    'pl-1',
    members('agriculture', { capital: 2, vision: 3, execution: 1 }).map((m) => ({ person_id: m.person_id, sectors: [m.sector] })),
  );
  const big = members('agriculture', { capital: 12, vision: 11, execution: 15 }).map((m, i) => ({
    person_id: `big${i}`,
    sectors: i < 4 ? [m.sector, sp('health', 'execution')] : [m.sector],
  }));
  byPlace.set('pl-2', big);
  byPlace.set('pl-3', big.map((p) => ({ ...p, person_id: `o-${p.person_id}` })));

  const full = buildPublicMap(places, byPlace, new Map(), c);
  assert.equal(full.length, 2 * c.sectors.length); // pl-3 belongs to another instance
  assertNoSubKCounts(full, k);

  // The big agriculture cell reveals exact counts and TR; the small ones do not.
  const bigAg = full.find((x) => x.place_id === 'pl-2' && x.sector === 'agriculture');
  assert.deepEqual(bigAg?.role_counts.partner, { kind: 'count', value: 12 });
  assert.equal(bigAg?.tr, 100);
  const smallAg = full.find((x) => x.place_id === 'pl-1' && x.sector === 'agriculture');
  assert.equal(smallAg?.tr, null);
  assert.equal(smallAg?.uncertainty, null);
  assert.equal(smallAg?.low_population, true);
  assert.equal(smallAg?.role_counts.partner.kind, 'band');

  // Differencing: every filtered response is an exact subset of the unfiltered one, so no
  // combination of filters yields information the unfiltered (safe) response does not.
  const fullByKey = new Map(full.map((x) => [cellKey(x.place_id, x.sector), JSON.stringify(x)]));
  for (const sector of c.sectors) {
    const filtered = buildPublicMap(places, byPlace, new Map(), c, { sector });
    assert.ok(filtered.every((x) => x.sector === sector));
    assertNoSubKCounts(filtered, k);
    for (const x of filtered) assert.equal(JSON.stringify(x), fullByKey.get(cellKey(x.place_id, x.sector)));
  }
  // And no cell carries a cross-sector or cross-place total to subtract from.
  for (const x of full) assert.deepEqual(Object.keys(x.role_counts).sort(), ['ambassador', 'leader', 'partner']);
});

test('k_min comes from config: raising it bands previously revealed counts', () => {
  const ms = members('agriculture', { capital: 12, vision: 12, execution: 12 });
  const base = cfg();
  const strict = cfg({ privacy: { ...base.privacy, k_min: 20 } });
  const cell = computeReadiness(place, 'agriculture', ms, [], base);
  assert.equal(publishReadiness(cell, place, base).role_counts.partner.kind, 'count');
  assert.equal(publishReadiness(cell, place, strict).role_counts.partner.kind, 'band');
});
