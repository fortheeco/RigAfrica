import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { DEFAULT_CONFIG, resolveInstanceConfig, validateConfig, validateValueSplit } from '../src/config.ts';
import { testConfig } from './helpers.ts';

const yamlPath = new URL('../../../config/pal.config.yaml', import.meta.url);

test('shipped pal.config.yaml validates and equals DEFAULT_CONFIG', () => {
  const r = validateConfig(parse(readFileSync(yamlPath, 'utf8')));
  assert.ok(r.ok, r.ok ? '' : JSON.stringify(r.issues));
  assert.deepEqual(r.config, DEFAULT_CONFIG);
});

test('unknown keys are rejected, not ignored', () => {
  const raw = { ...structuredClone(DEFAULT_CONFIG), scoring: { ...DEFAULT_CONFIG.scoring, half_life_monthz: 12 } };
  const r = validateConfig(raw);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.issues.some((i) => i.path === '$.scoring.half_life_monthz'));
});

test('matching weights must sum to 1', () => {
  const raw = structuredClone(DEFAULT_CONFIG);
  raw.matching.weights.fit = 0.5;
  const r = validateConfig(raw);
  assert.ok(!r.ok && r.issues.some((i) => i.path === '$.matching.weights'));
});

test('unverified multiplier must stay 0 (stingy rule cannot be configured away)', () => {
  const raw = structuredClone(DEFAULT_CONFIG);
  raw.scoring.verification_multiplier.unverified = 0.2;
  assert.equal(validateConfig(raw).ok, false);
});

test('purge_days cannot exceed 30', () => {
  const raw = structuredClone(DEFAULT_CONFIG);
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
