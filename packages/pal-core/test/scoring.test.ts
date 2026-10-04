import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ageMonths,
  computeProfile,
  decayFactor,
  evidenceContribution,
  historyPoint,
  MS_PER_MONTH,
} from '../src/scoring.ts';
import type { ClaimedItem, PersonProfile, ScoreInput } from '../src/scoring.ts';
import { AXES } from '../src/config.ts';
import { cfg, daysBefore, ev, monthsBefore, NOW } from './helpers.ts';

function input(over: Partial<ScoreInput> = {}): ScoreInput {
  return { person_id: 'p1', evidence: [], claimed: [], frozen_ids: new Set(), history: [], now: NOW, ...over };
}

function axis(p: PersonProfile, sector: string, a: (typeof AXES)[number]) {
  const s = p.sectors.find((x) => x.sector === sector);
  assert.ok(s, `sector ${sector} missing`);
  return s.axes[a];
}

let cseq = 0;
function claim(over: Partial<ClaimedItem> = {}): ClaimedItem {
  cseq += 1;
  return {
    id: `cl-${cseq}`,
    axis: 'execution',
    sector: 'agriculture',
    feature_type: 'offer',
    value: `skill ${cseq}`,
    weight: 1,
    evidence_ref: `post:${cseq}`,
    ...over,
  };
}

// ---- Acceptance: decay -----------------------------------------------------------------------

test('DECAY: an event aged exactly 18 months contributes exactly half of the same fresh event', () => {
  const c = cfg();
  const fresh = ev({ occurred_at: NOW });
  const old = ev({ occurred_at: monthsBefore(NOW, 18) });
  assert.equal(ageMonths(old.occurred_at, NOW), 18);
  const f = evidenceContribution(fresh, ageMonths(fresh.occurred_at, NOW), c.scoring);
  const o = evidenceContribution(old, ageMonths(old.occurred_at, NOW), c.scoring);
  assert.equal(o, f / 2);
  assert.equal(decayFactor(18, 18), 0.5);

  // Same through the full profile path.
  const pf = computeProfile(input({ evidence: [fresh] }), c);
  const po = computeProfile(input({ evidence: [old] }), c);
  assert.equal(axis(po, 'agriculture', 'execution').verified, axis(pf, 'agriculture', 'execution').verified / 2);
});

test('MS_PER_MONTH is an integer so whole-month ages are exact', () => {
  assert.ok(Number.isInteger(MS_PER_MONTH));
});

// ---- Acceptance: stingy ----------------------------------------------------------------------

test('STINGY: a person with only claimed signals has V = 0 for every axis and sector', () => {
  const c = cfg();
  const claimed: ClaimedItem[] = [];
  for (const sector of c.sectors) for (const a of AXES) for (let i = 0; i < 8; i++) claimed.push(claim({ sector, axis: a }));
  const p = computeProfile(input({ claimed }), c);
  assert.equal(p.sectors.length, c.sectors.length);
  for (const s of p.sectors) {
    for (const a of AXES) {
      assert.equal(s.axes[a].verified, 0);
      assert.equal(s.axes[a].claimed, c.scoring.claimed_cap_per_axis);
      assert.equal(s.axes[a].state, 'Unverified');
      assert.equal(s.axes[a].confidence, 0);
    }
    // B = 0.4 * 25 = 10 < role_threshold: no role from claims alone.
    assert.deepEqual(s.roles, []);
  }
  assert.ok(p.evidence_lines.every((l) => l.kind === 'claimed'));
});

test('unverified events contribute 0 to V', () => {
  const p = computeProfile(input({ evidence: [ev({ verification_level: 'unverified' })] }), cfg());
  assert.equal(p.sectors.length, 0); // nothing scored at all
  assert.equal(p.evidence_lines[0]?.status, 'not_verified');
  assert.equal(p.evidence_lines[0]?.points, 0);
  const mixed = computeProfile(input({ evidence: [ev(), ev({ verification_level: 'unverified' })] }), cfg());
  assert.equal(axis(mixed, 'agriculture', 'execution').verified, 10);
});

// ---- Formula details -------------------------------------------------------------------------

test('V formula: weight * quality * multiplier * decay, clamped at 100', () => {
  const c = cfg();
  const p = computeProfile(
    input({
      evidence: [
        ev({ evidence_type: 'team_led', quality: 0.5 }), // 10 * 0.7 * 0.5 * 1 = 3.5
        ev({ evidence_type: 'sprint_closed_verified', verification_level: 'corroborated' }), // 12.5
      ],
    }),
    c,
  );
  assert.equal(axis(p, 'agriculture', 'execution').verified, 16);

  const many = Array.from({ length: 20 }, () => ev());
  assert.equal(axis(computeProfile(input({ evidence: many }), c), 'agriculture', 'execution').verified, 100);
});

test('ten full-strength fresh verified events reach 100', () => {
  const p = computeProfile(input({ evidence: Array.from({ length: 10 }, () => ev()) }), cfg());
  assert.equal(axis(p, 'agriculture', 'execution').verified, 100);
});

test('evidence types without weight on the axis are ignored and marked', () => {
  const p = computeProfile(input({ evidence: [ev({ axis: 'capital', evidence_type: 'team_led' })] }), cfg());
  assert.equal(p.sectors.length, 0);
  assert.equal(p.evidence_lines[0]?.status, 'no_weight');
});

test('claimed C: distinct items only, capped, unvalidated-language weight halves points', () => {
  const c = cfg();
  const p = computeProfile(
    input({
      claimed: [
        claim({ value: 'Solar Install' }),
        claim({ value: '  solar   install ' }), // duplicate after normalisation
        claim({ value: 'drip irrigation', weight: 0.5 }),
      ],
    }),
    c,
  );
  assert.equal(axis(p, 'agriculture', 'execution').claimed, 7.5);
  assert.equal(p.evidence_lines.filter((l) => l.status === 'duplicate').length, 1);
});

test('claimed items without axis or sector are unscoped (feed matching text only)', () => {
  const p = computeProfile(input({ claimed: [claim({ axis: null }), claim({ sector: null })] }), cfg());
  assert.equal(p.sectors.length, 0);
  assert.ok(p.evidence_lines.every((l) => l.status === 'unscoped'));
});

test('match score B = min(100, V + 0.4 C)', () => {
  const evidence = Array.from({ length: 3 }, () => ev()); // V = 30
  const claimed = Array.from({ length: 5 }, () => claim()); // C = 25
  const a = axis(computeProfile(input({ evidence, claimed }), cfg()), 'agriculture', 'execution');
  assert.equal(a.verified, 30);
  assert.equal(a.claimed, 25);
  assert.equal(a.match, 40);
});

test('confidence = verified_share * breadth', () => {
  const evidence = [
    ev({ evidence_type: 'sprint_closed_verified', verifier_id: 'v1' }),
    ev({ evidence_type: 'team_led', verifier_id: 'v1' }),
  ]; // V = 17
  const claimed = [claim()]; // C = 5
  const a = axis(computeProfile(input({ evidence, claimed }), cfg()), 'agriculture', 'execution');
  const share = 17 / 22;
  const br = 0.5 * (2 / 3) + 0.5 * (1 / 2);
  assert.ok(Math.abs(a.confidence - share * br) < 1e-12);
});

test('frozen (disputed) evidence lines are excluded until resolved', () => {
  const e1 = ev();
  const e2 = ev();
  const p = computeProfile(input({ evidence: [e1, e2], frozen_ids: new Set([e1.id]) }), cfg());
  assert.equal(axis(p, 'agriculture', 'execution').verified, 10);
  assert.equal(p.evidence_lines.find((l) => l.id === e1.id)?.status, 'frozen');
});

test('future-dated events are ignored', () => {
  const p = computeProfile(input({ evidence: [ev({ occurred_at: '2027-01-01T00:00:00Z' })] }), cfg());
  assert.equal(p.sectors.length, 0);
});

test('unknown sectors are unscoped', () => {
  const p = computeProfile(input({ evidence: [ev({ sector: 'mining' })] }), cfg());
  assert.equal(p.sectors.length, 0);
  assert.equal(p.evidence_lines[0]?.status, 'unscoped');
});

// ---- Roles -----------------------------------------------------------------------------------

test('roles: primary at threshold, second within multi_role_ratio, labels mapped', () => {
  const c = cfg();
  const evidence = [
    ...Array.from({ length: 5 }, () => ev({ axis: 'execution' })), // 50
    ...Array.from({ length: 4 }, () => ev({ axis: 'capital', evidence_type: 'pool_contribution' })), // 40 = 0.8*50
    ...Array.from({ length: 2 }, () => ev({ axis: 'vision', evidence_type: 'referral_active' })), // 14
  ];
  const s = computeProfile(input({ evidence }), c).sectors[0]!;
  assert.deepEqual(
    s.roles.map((r) => [r.label, r.primary]),
    [
      ['Leader', true],
      ['Partner', false],
    ],
  );
});

test('roles: second role dropped when below ratio; no role below threshold', () => {
  const evidence = [
    ...Array.from({ length: 5 }, () => ev({ axis: 'execution' })), // 50
    ...Array.from({ length: 3 }, () => ev({ axis: 'capital', evidence_type: 'pool_contribution' })), // 30 < 40
  ];
  const s = computeProfile(input({ evidence }), cfg()).sectors[0]!;
  assert.deepEqual(s.roles.map((r) => r.label), ['Leader']);
  const low = computeProfile(input({ evidence: [ev(), ev()] }), cfg()).sectors[0]!;
  assert.deepEqual(low.roles, []);
});

// ---- States ----------------------------------------------------------------------------------

test('state Rising uses the history snapshot from >= 90 days ago', () => {
  const c = cfg();
  const evidence = Array.from({ length: 3 }, () => ev()); // V = 30 now
  const history = [{ taken_at: daysBefore(NOW, 120), verified: { 'agriculture:execution': 20 } }];
  assert.equal(axis(computeProfile(input({ evidence, history }), c), 'agriculture', 'execution').state, 'Rising');
  const flat = [{ taken_at: daysBefore(NOW, 120), verified: { 'agriculture:execution': 28 } }];
  assert.equal(axis(computeProfile(input({ evidence, history: flat }), c), 'agriculture', 'execution').state, 'Established');
});

test('state Rising falls back to an as-of recompute when no snapshot is old enough', () => {
  const evidence = [ev({ occurred_at: daysBefore(NOW, 10) })]; // nothing existed 90 days ago
  assert.equal(axis(computeProfile(input({ evidence }), cfg()), 'agriculture', 'execution').state, 'Rising');
});

test('state Dormant: low V after a high peak; Emerging otherwise', () => {
  const evidence = [ev({ occurred_at: monthsBefore(NOW, 30) })]; // ~3.15 now
  const history = [
    { taken_at: monthsBefore(NOW, 24), verified: { 'agriculture:execution': 35 } },
    { taken_at: daysBefore(NOW, 100), verified: { 'agriculture:execution': 4 } },
  ];
  assert.equal(axis(computeProfile(input({ evidence, history }), cfg()), 'agriculture', 'execution').state, 'Dormant');
  const noPeak = [{ taken_at: daysBefore(NOW, 100), verified: { 'agriculture:execution': 4 } }];
  assert.equal(
    axis(computeProfile(input({ evidence, history: noPeak }), cfg()), 'agriculture', 'execution').state,
    'Emerging',
  );
});

test('profile carries model_version and a history point round-trips V', () => {
  const p = computeProfile(input({ evidence: [ev()] }), cfg());
  assert.equal(p.model_version, 'pal-core@0.1.0');
  assert.equal(historyPoint(p).verified['agriculture:execution'], 10);
});

test('config change changes output with no code change', () => {
  const evidence = [ev({ occurred_at: monthsBefore(NOW, 12) })];
  const a = axis(computeProfile(input({ evidence }), cfg()), 'agriculture', 'execution').verified;
  const base = cfg();
  const c2 = cfg({ scoring: { ...base.scoring, half_life_months: 6 } });
  const b = axis(computeProfile(input({ evidence }), c2), 'agriculture', 'execution').verified;
  assert.ok(b < a);
  assert.equal(b, 2.5);
});
