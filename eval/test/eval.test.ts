import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { loadConfig, loadFixtures, runEval, writeOutputs } from '../src/run.ts';
import { DEFAULT_GENERATE_OPTIONS, generateDataset } from '../src/generate.ts';
import { groupGap, median } from '../src/fairness.ts';
import { languageGate, parseLabelled } from '../src/language-gate.ts';
import { MS_PER_MONTH } from '../../packages/pal-core/src/scoring.ts';

const config = loadConfig();
const fixtures = loadFixtures();
const small = { ...DEFAULT_GENERATE_OPTIONS, members_per_place: 40 };
const AT = '2026-10-04T00:00:00.000Z';

test('generator is deterministic per seed and uses fake people only', () => {
  const a = generateDataset(config, fixtures, small);
  const b = generateDataset(config, fixtures, small);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  const c = generateDataset(config, fixtures, { ...small, seed: 7 });
  assert.notEqual(JSON.stringify(a.members), JSON.stringify(c.members));
  for (const m of a.members) {
    assert.match(m.person_id, /^syn-/);
    assert.ok(!('name' in m));
  }
  // Events span the configured history window; claimed and verified both present.
  const ages = a.members.flatMap((m) => m.evidence.map((e) => (Date.parse(a.now) - Date.parse(e.occurred_at)) / MS_PER_MONTH));
  assert.ok(Math.max(...ages) > 30 && Math.max(...ages) <= 36);
  assert.ok(a.members.some((m) => m.footprint === 'low') && a.members.some((m) => m.footprint === 'high'));
  assert.ok(a.members.some((m) => m.evidence.some((e) => e.verification_level === 'unverified')));
});

test('EVAL: harness runs end to end and writes the fairness report', () => {
  const out = runEval(config, fixtures, small, { generated_at: AT });
  const dir = mkdtempSync(join(tmpdir(), 'pal-eval-'));
  const files = writeOutputs(out, dir);
  for (const f of files) assert.ok(existsSync(f));
  const fairness = JSON.parse(readFileSync(join(dir, 'fairness-report.json'), 'utf8')) as Record<string, unknown>;

  // Shape matches the OpenAPI FairnessReport the UI reads.
  const api = parse(readFileSync(new URL('../../docs/pal-api.openapi.yaml', import.meta.url), 'utf8')) as {
    components: { schemas: { FairnessReport: { required: string[] } } };
  };
  for (const k of api.components.schemas.FairnessReport.required) assert.ok(k in fairness, `missing ${k}`);
  assert.equal(fairness['dataset'], 'synthetic');
  assert.equal(fairness['threshold'], 15);

  const m = out.report.metrics;
  assert.ok(m.role_calibration.predicted_with_role > 0);
  assert.ok((m.precision_at_k.precision ?? 0) > 0);
  assert.ok((m.completion_lift.lift ?? 0) > 1, 'proposed trios should beat random matching');
  assert.ok(m.map_stability.cells > 0);
  assert.ok(out.outcomes.length > 0);
});

test('eval is reproducible: same seed and timestamp give byte-identical reports', () => {
  const a = runEval(config, fixtures, small, { generated_at: AT });
  const b = runEval(config, fixtures, small, { generated_at: AT });
  assert.equal(JSON.stringify(a.report), JSON.stringify(b.report));
  assert.equal(JSON.stringify(a.fairness), JSON.stringify(b.fairness));
});

test('public map in the eval run never reveals a count below k_min', () => {
  const out = runEval(config, fixtures, small, { generated_at: AT });
  for (const inst of out.run.instances) {
    for (const cell of inst.public_map) {
      for (const c of Object.values(cell.role_counts)) if (c.kind === 'count') assert.ok(c.value >= inst.cfg.privacy.k_min);
      if (cell.tr !== null) assert.ok(Object.values(cell.role_counts).every((c) => c.kind === 'count'));
    }
  }
});

test('fairness: gap flagged above threshold; sub-k groups banded with no median', () => {
  const lo = Array.from({ length: 12 }, () => 10);
  const hi = Array.from({ length: 12 }, () => 30);
  assert.equal(groupGap('x', lo, hi, 10, 15).flagged, true);
  assert.equal(groupGap('x', lo, hi, 10, 25).flagged, false);
  const small = groupGap('x', lo.slice(0, 5), hi, 10, 15);
  assert.equal(small.median_gap, null);
  assert.equal(small.flagged, false);
  assert.deepEqual(small.low_n, { kind: 'band', band: 'fewer than 10', lt: 10 });
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
});

test('fairness audit detects injected footprint bias that the unbiased run does not have', () => {
  const fair = runEval(config, fixtures, small, { generated_at: AT }).fairness.footprint.overall.median_gap ?? 0;
  const biased = runEval(config, fixtures, { ...small, footprint_activity_correlation: 2 }, { generated_at: AT }).fairness.footprint.overall.median_gap ?? 0;
  assert.ok(biased > fair, `biased ${biased} <= fair ${fair}`);
});

test('gender is only self-reported and only feeds the audit', () => {
  const out = runEval(config, fixtures, small, { generated_at: AT });
  assert.ok(out.fairness.gender.every((g) => g.group.startsWith('gender:')));
  assert.ok(!out.fairness.gender.some((g) => g.group === 'gender:null'));
});

test('language gate: no data, too few items, low precision, passed', () => {
  assert.equal(languageGate('sw', null).reason, 'no_data');
  const line = (i: number, t: string, ok: boolean) => JSON.stringify({ id: `${t}-${i}`, language: 'sw', feature_type: t, correct: ok });
  const make = (n: number, okRate: number) =>
    ['sector_interest', 'affiliation'].flatMap((t) => Array.from({ length: n }, (_, i) => line(i, t, i < n * okRate))).join('\n');
  assert.equal(languageGate('sw', parseLabelled(make(99, 1), 'sw')).reason, 'insufficient_items');
  assert.equal(languageGate('sw', parseLabelled(make(100, 0.79), 'sw')).reason, 'low_precision');
  const pass = languageGate('sw', parseLabelled(make(100, 0.8), 'sw'));
  assert.equal(pass.validated, true);
  assert.equal(pass.per_type['affiliation']?.precision, 0.8);
  const bad = parseLabelled(`${line(1, 'affiliation', true)}\nnot json\n${line(1, 'affiliation', true)}\n{"id":"x","language":"yo","feature_type":"affiliation","correct":true}`, 'sw');
  assert.deepEqual([bad.items.length, bad.invalid_lines], [1, 3]);
});
