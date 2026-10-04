import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { DEFAULT_SETTINGS, resolveInstanceConfig, validateConfig, validateValueSplit } from '../src/config.ts';
import { testConfig } from './helpers.ts';

const yamlPath = new URL('../../../config/pal.config.yaml', import.meta.url);

test('shipped pal.config.yaml validates and its settings equal DEFAULT_SETTINGS', () => {
  const r = validateConfig(parse(readFileSync(yamlPath, 'utf8')));
  assert.ok(r.ok, r.ok ? '' : JSON.stringify(r.issues));
  const { instances, ...settings } = r.config;
  assert.deepEqual(settings, DEFAULT_SETTINGS);
  assert.ok(instances.length >= 1);
  for (const i of instances) assert.equal(resolveInstanceConfig(r.config, i.id).instance.id, i.id);
});

test('unknown keys are rejected, not ignored', () => {
  const raw = { ...testConfig(), scoring: { ...DEFAULT_SETTINGS.scoring, half_life_monthz: 12 } };
  const r = validateConfig(raw);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.issues.some((i) => i.path === '$.scoring.half_life_monthz'));
});

test('matching weights must sum to 1', () => {
  const raw = testConfig();
  raw.matching.weights.fit = 0.5;
  const r = validateConfig(raw);
  assert.ok(!r.ok && r.issues.some((i) => i.path === '$.matching.weights'));
});

test('unverified multiplier must stay 0 (stingy rule cannot be configured away)', () => {
  const raw = testConfig();
  raw.scoring.verification_multiplier.unverified = 0.2;
  assert.equal(validateConfig(raw).ok, false);
});

test('purge_days cannot exceed 30', () => {
  const raw = testConfig();
  raw.privacy.purge_days = 45;
  assert.equal(validateConfig(raw).ok, false);
});

test('instance overrides are deep-merged and validated after merge', () => {
  const c = testConfig();
  c.instances[0]!.overrides = { privacy: { k_min: 15, purge_days: 30 }, sparks: { ...c.sparks, funding_cap: 500000 } };
  const r = validateConfig(c);
  assert.ok(r.ok);
  const res = resolveInstanceConfig(r.config, 'alpha');
  assert.equal(res.privacy.k_min, 15);
  assert.equal(res.sparks.funding_cap, 500000);
  assert.equal(res.scoring.half_life_months, 18);
  assert.equal(res.instance.id, 'alpha');

  const bad = testConfig();
  bad.instances[0]!.overrides = { privacy: { k_min: 1, purge_days: 30 } };
  const rb = validateConfig(bad);
  assert.ok(!rb.ok && rb.issues.some((i) => i.path.startsWith('$.instances[0].overrides(merged)')));
});

test('unknown instance throws a typed error', () => {
  assert.throws(() => resolveInstanceConfig(testConfig(), 'nowhere'), { code: 'unknown_instance' });
});

test('value split validation', () => {
  assert.equal(validateValueSplit({ partner: 0.3, ambassador: 0.2, leader: 0.5 }), null);
  assert.notEqual(validateValueSplit({ partner: 0.3, leader: 0.5 }), null);
  assert.notEqual(validateValueSplit({}), null);
});

test('CONFIG: two instances, same input, different outputs purely from config', async () => {
  const { computeProfile } = await import('../src/scoring.ts');
  const { bandCount } = await import('../src/privacy.ts');
  const { checkCreate } = await import('../src/sparks.ts');
  const { ev, monthsBefore, NOW } = await import('./helpers.ts');
  const c = testConfig();
  c.instances = [
    { id: 'first', country: 'AA', place_type: 'ward', currency: 'AAA', languages: ['en'], regulator: 'R1' },
    {
      id: 'second',
      country: 'BB',
      place_type: 'county',
      currency: 'BBB',
      languages: ['en'],
      regulator: 'R2',
      overrides: {
        scoring: { ...c.scoring, half_life_months: 6 },
        privacy: { k_min: 5, purge_days: 14 },
        sparks: { ...c.sparks, funding_cap: 1000, value_split_defaults: { leader: 1 } },
      },
    },
  ];
  const r = validateConfig(c);
  assert.ok(r.ok);
  const a = resolveInstanceConfig(r.config, 'first');
  const b = resolveInstanceConfig(r.config, 'second');
  const input = { person_id: 'p', evidence: [ev({ occurred_at: monthsBefore(NOW, 12) })], claimed: [], frozen_ids: new Set<string>(), history: [], now: NOW };
  assert.notEqual(computeProfile(input, a).sectors[0]?.axes.execution.verified, computeProfile(input, b).sectors[0]?.axes.execution.verified);
  assert.equal(bandCount(7, a.privacy.k_min).kind, 'band');
  assert.equal(bandCount(7, b.privacy.k_min).kind, 'count');
  const spark = { sector: 'agriculture', duration_days: 7, funded: true, requested_amount: 500, value_split: null };
  assert.equal(checkCreate(spark, a).ok, false);
  assert.equal(checkCreate(spark, b).ok, true);
});
