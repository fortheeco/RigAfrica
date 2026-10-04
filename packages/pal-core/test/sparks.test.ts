import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canTransition, checkCreate, checkFundsMove, checkInvite, checkOpen, countActiveVerifiers } from '../src/sparks.ts';
import type { SparkRecord } from '../src/sparks.ts';
import { cfg, daysBefore, NOW } from './helpers.ts';

const base = cfg();
const funded = cfg({ sparks: { ...base.sparks, funding_cap: 1_000_000, value_split_defaults: { partner: 0.2, ambassador: 0.2, leader: 0.6 } } });

function spark(over: Partial<SparkRecord> = {}): SparkRecord {
  return {
    id: 's1',
    place_id: 'pl-1',
    sector: 'agriculture',
    duration_days: 14,
    status: 'inviting',
    funded: false,
    requested_amount: null,
    value_split: null,
    split_locked_at: null,
    steward_approved_at: NOW,
    accepted_roles: ['capital', 'vision', 'execution'],
    ...over,
  };
}

test('FUNDING GATE: funded Spark creation fails while funding_cap is null', () => {
  const r = checkCreate(spark({ funded: true, requested_amount: 1000, value_split: { partner: 0.5, leader: 0.5 } }), base);
  assert.deepEqual(r, { ok: false, errors: ['funding_cap_unset'] });
  // Unfunded Sparks are allowed without a cap or split.
  assert.deepEqual(checkCreate(spark(), base), { ok: true });
  // Once the instance sets a cap (config only, no code change) the same Spark passes.
  assert.deepEqual(checkCreate(spark({ funded: true, requested_amount: 1000 }), funded), { ok: true });
});

test('FUNDING GATE: a Spark cannot open in a place with 0 active verifiers', () => {
  assert.deepEqual(checkOpen(spark(), 0, base), { ok: false, errors: ['no_active_verifier'] });
  assert.deepEqual(checkOpen(spark(), 1, base), { ok: true });
});

test('create checks duration, sector, amount, cap and split', () => {
  const r = checkCreate(spark({ duration_days: 10, sector: 'mining', funded: true, requested_amount: 2_000_000 }), funded);
  assert.deepEqual(r, { ok: false, errors: ['invalid_duration', 'unknown_sector', 'over_funding_cap'] });
  const noSplit = cfg({ sparks: { ...base.sparks, funding_cap: 10 } });
  assert.deepEqual(checkCreate(spark({ funded: true, requested_amount: 5 }), noSplit), { ok: false, errors: ['value_split_missing'] });
  assert.deepEqual(checkCreate(spark({ value_split: { partner: 0.9 } }), base), { ok: false, errors: ['value_split_invalid'] });
});

test('open requires approval, a full trio, and a locked split for funded Sparks', () => {
  const r = checkOpen(spark({ steward_approved_at: null, accepted_roles: ['capital'], funded: true, requested_amount: 10 }), 2, funded);
  assert.deepEqual(r, { ok: false, errors: ['not_steward_approved', 'trio_incomplete', 'split_not_locked'] });
  assert.deepEqual(checkOpen(spark({ funded: true, requested_amount: 10, split_locked_at: NOW }), 2, funded), { ok: true });
  // Cap removed after drafting: re-checked at open.
  assert.deepEqual(checkOpen(spark({ funded: true, requested_amount: 10, split_locked_at: NOW }), 2, base), {
    ok: false,
    errors: ['funding_cap_unset', 'value_split_missing'],
  });
});

test('invites need steward approval; funds never move before the split is locked', () => {
  assert.deepEqual(checkInvite({ steward_approved_at: null, status: 'approved' }), { ok: false, errors: ['not_steward_approved'] });
  assert.deepEqual(checkInvite({ steward_approved_at: NOW, status: 'approved' }), { ok: true });
  assert.deepEqual(checkFundsMove(spark({ status: 'active', funded: true })), { ok: false, errors: ['split_not_locked'] });
  assert.deepEqual(checkFundsMove(spark({ status: 'active', funded: true, split_locked_at: NOW })), { ok: true });
  assert.deepEqual(checkFundsMove(spark({ status: 'draft' })), { ok: false, errors: ['invalid_transition'] });
});

test('status transitions', () => {
  assert.equal(canTransition('draft', 'approved'), true);
  assert.equal(canTransition('draft', 'open'), false);
  assert.equal(canTransition('closed', 'draft'), false);
});

test('active verifiers: place or ancestor, within active window, distinct', () => {
  const a = [
    { verifier_id: 'v1', place_id: 'county', active_from: daysBefore(NOW, 10), active_to: null },
    { verifier_id: 'v1', place_id: 'sub', active_from: daysBefore(NOW, 10), active_to: null },
    { verifier_id: 'v2', place_id: 'sub', active_from: daysBefore(NOW, 10), active_to: daysBefore(NOW, 1) },
    { verifier_id: 'v3', place_id: 'other', active_from: daysBefore(NOW, 10), active_to: null },
    { verifier_id: 'v4', place_id: 'sub', active_from: '2027-01-01T00:00:00Z', active_to: null },
  ];
  assert.equal(countActiveVerifiers(a, ['sub', 'county'], NOW), 1);
  assert.equal(countActiveVerifiers(a, ['other'], NOW), 1);
  assert.equal(countActiveVerifiers(a, ['nowhere'], NOW), 0);
});
