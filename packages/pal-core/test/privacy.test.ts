import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accessLogEntry,
  bandCount,
  bioCodeFromBytes,
  checkConsent,
  matchContactHashes,
  normalisePhoneAlias,
  planPurge,
  safeLog,
  verifyBioCode,
} from '../src/privacy.ts';
import type { Consent } from '../src/privacy.ts';
import { planSignalUpsert, toSignalDrafts, validateExtraction } from '../src/extraction-schema.ts';
import type { StoredSignal } from '../src/extraction-schema.ts';
import { computeProfile } from '../src/scoring.ts';
import type { ClaimedItem } from '../src/scoring.ts';
import { cfg, daysBefore, NOW } from './helpers.ts';

function consent(over: Partial<Consent> = {}): Consent {
  return {
    person_id: 'p1',
    source: 'x',
    method: 'oauth',
    scopes: ['public_posts'],
    granted_at: daysBefore(NOW, 30),
    revoked_at: null,
    handle_verified_at: daysBefore(NOW, 30),
    ...over,
  };
}

test('consent gate: none, revoked, scope missing, unverified handle, ok', () => {
  assert.deepEqual(checkConsent([], 'p1', 'x', 'public_posts', NOW), { ok: false, code: 'no_consent' });
  assert.deepEqual(checkConsent([consent({ revoked_at: daysBefore(NOW, 1) })], 'p1', 'x', 'public_posts', NOW), {
    ok: false,
    code: 'consent_revoked',
  });
  assert.deepEqual(checkConsent([consent({ scopes: ['profile'] })], 'p1', 'x', 'public_posts', NOW), {
    ok: false,
    code: 'scope_missing',
  });
  assert.deepEqual(checkConsent([consent({ handle_verified_at: null })], 'p1', 'x', 'public_posts', NOW), {
    ok: false,
    code: 'handle_unverified',
  });
  assert.equal(checkConsent([consent()], 'p1', 'x', 'public_posts', NOW).ok, true);
  // Another person's consent never counts.
  assert.equal(checkConsent([consent({ person_id: 'p2' })], 'p1', 'x', 'public_posts', NOW).ok, false);
  // Self-declared needs no handle proof.
  assert.equal(
    checkConsent([consent({ method: 'self_declared', handle_verified_at: null })], 'p1', 'x', 'public_posts', NOW).ok,
    true,
  );
});

test('latest consent row wins: revoke after grant blocks; re-grant after revoke allows', () => {
  const old = consent({ granted_at: daysBefore(NOW, 60), revoked_at: daysBefore(NOW, 40) });
  const regrant = consent({ granted_at: daysBefore(NOW, 10) });
  assert.equal(checkConsent([old, regrant], 'p1', 'x', 'public_posts', NOW).ok, true);
  assert.equal(checkConsent([old], 'p1', 'x', 'public_posts', NOW).ok, false);
});

test('bio code: generated from supplied bytes, verified within ttl', () => {
  const code = bioCodeFromBytes(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]));
  assert.match(code, /^ECO-[A-Z2-9]{8}$/);
  const ch = { code, issued_at: daysBefore(NOW, 0.5), ttl_hours: 24 };
  assert.equal(verifyBioCode(`farmer | ${code.toLowerCase()} | Ikeja`, ch, NOW), 'verified');
  assert.equal(verifyBioCode('nothing here', ch, NOW), 'code_not_found');
  assert.equal(verifyBioCode(code, { ...ch, issued_at: daysBefore(NOW, 2) }, NOW), 'expired');
});

test('NON-MEMBER: unmatched contact hashes are dropped and only member ids survive', () => {
  const index = new Map([
    ['h-alice', 'person-a'],
    ['h-bob', 'person-b'],
    ['h-self', 'p1'],
  ]);
  const r = matchContactHashes(['h-alice', 'h-unknown-1', 'h-bob', 'h-unknown-2', 'h-alice', 'h-self'], index, 'p1');
  assert.deepEqual(r, { matched_person_ids: ['person-a', 'person-b'], dropped: 2 });
  // The result structurally cannot carry an unmatched hash.
  assert.ok(!JSON.stringify(r).includes('unknown'));
});

test('phone normalisation uses the caller-supplied calling code', () => {
  assert.equal(normalisePhoneAlias('0803 123 4567', '234'), 'phone:+2348031234567');
  assert.equal(normalisePhoneAlias('+254 712 345678', '254'), 'phone:+254712345678');
  assert.equal(normalisePhoneAlias('12', '254'), null);
});

test('k-anonymity band: below k_min (including 0) reveals no number', () => {
  assert.deepEqual(bandCount(9, 10), { kind: 'band', band: 'fewer than 10', lt: 10 });
  assert.deepEqual(bandCount(0, 10), { kind: 'band', band: 'fewer than 10', lt: 10 });
  assert.deepEqual(bandCount(10, 10), { kind: 'count', value: 10 });
});

test('ACCESS-LOG: steward view produces an entry; owner view does not', () => {
  assert.equal(accessLogEntry({ id: 'p1', role: 'owner' }, 'p1', 'profile', 'self', NOW), null);
  const e = accessLogEntry({ id: 's1', role: 'steward' }, 'p1', 'profile', 'spark_review', NOW);
  assert.deepEqual(e, {
    viewer_id: 's1',
    viewer_role: 'steward',
    subject_person_id: 'p1',
    resource: 'profile',
    purpose: 'spark_review',
    at: NOW,
  });
  // An "owner" role claiming someone else's id is still logged.
  assert.notEqual(accessLogEntry({ id: 'p2', role: 'owner' }, 'p1', 'profile', 'x', NOW), null);
});

test('safeLog drops anything that is not an id or a count', () => {
  const s = safeLog({ event: 'ingest', ids: { person: 'p1', text: 'I love farming in Ikeja!' }, counts: { n: 3 } });
  assert.deepEqual(JSON.parse(s), { event: 'ingest', ids: { person: 'p1' }, counts: { n: 3 } });
});

// ---- Acceptance: consent + purge + recompute on a simulated clock -------------------------------

test('CONSENT: ingest rejects without/revoked consent; revoke purges and recomputes within purge_days', () => {
  const c = cfg();
  const consents: Consent[] = [];
  let signals: StoredSignal[] = [];
  let seq = 0;

  const raw = {
    features: [
      { type: 'offer', sector: 'agriculture', axis_hint: 'execution', value: 'irrigation', evidence_ref: 'post:1', confidence: 0.9, language: 'en' },
      { type: 'offer', sector: 'agriculture', axis_hint: 'execution', value: 'seed bank', evidence_ref: 'post:2', confidence: 0.9, language: 'en' },
    ],
  };

  function ingest(now: string): 'ok' | string {
    const gate = checkConsent(consents, 'p1', 'x', 'public_posts', now);
    if (!gate.ok) return gate.code;
    const drafts = toSignalDrafts(validateExtraction(raw, c).accepted, { person_id: 'p1', source: 'x' }, c);
    const plan = planSignalUpsert(signals, drafts);
    signals = [...signals.filter((s) => !plan.delete.includes(s.id)), ...plan.insert.map((d) => ({ ...d, id: `s${++seq}` }))];
    return 'ok';
  }
  function claimedC(now: string): number {
    const claimed: ClaimedItem[] = signals.map((s) => ({
      id: s.id,
      axis: s.axis,
      sector: s.sector,
      feature_type: s.feature_type,
      value: s.value,
      weight: s.weight,
      evidence_ref: s.evidence_ref,
    }));
    const p = computeProfile({ person_id: 'p1', evidence: [], claimed, frozen_ids: new Set(), history: [], now }, c);
    return p.sectors[0]?.axes.execution.claimed ?? 0;
  }

  const t0 = daysBefore(NOW, 100);
  assert.equal(ingest(t0), 'no_consent');
  assert.equal(signals.length, 0);

  consents.push(consent({ granted_at: t0, handle_verified_at: t0 }));
  assert.equal(ingest(daysBefore(NOW, 99)), 'ok');
  assert.equal(signals.length, 2);
  let profileC = claimedC(daysBefore(NOW, 99));
  assert.equal(profileC, 10);

  // Revoke. Ingest is refused immediately.
  const revokedAt = daysBefore(NOW, 50);
  consents[0] = { ...consents[0]!, revoked_at: revokedAt };
  assert.equal(ingest(daysBefore(NOW, 49)), 'consent_revoked');

  // Purge job runs daily on the simulated clock; it must finish within purge_days.
  let purgedOnDay: number | null = null;
  for (let day = 0; day <= c.privacy.purge_days; day++) {
    const now = new Date(Date.parse(revokedAt) + day * 86_400_000 + 3_600_000).toISOString();
    const plan = planPurge(consents, signals, now, c.privacy.purge_days);
    assert.equal(plan.overdue.length, 0);
    if (plan.delete_ids.length > 0) {
      signals = signals.filter((s) => !plan.delete_ids.includes(s.id));
      assert.deepEqual(plan.people_to_recompute, ['p1']);
      profileC = claimedC(now); // recompute triggered by the purge
      purgedOnDay ??= day;
    }
  }
  assert.ok(purgedOnDay !== null && purgedOnDay <= c.privacy.purge_days);
  assert.equal(signals.length, 0);
  assert.equal(profileC, 0);
});

test('purge plan flags overdue targets past the deadline', () => {
  const revoked = consent({ revoked_at: daysBefore(NOW, 31) });
  const plan = planPurge([revoked], [{ id: 's1', person_id: 'p1', source: 'x' }], NOW, 30);
  assert.deepEqual(plan.delete_ids, ['s1']);
  assert.equal(plan.overdue.length, 1);
  // Other sources of the same person are untouched.
  const plan2 = planPurge([revoked], [{ id: 's2', person_id: 'p1', source: 'linkedin' }], NOW, 30);
  assert.deepEqual(plan2.delete_ids, []);
});
