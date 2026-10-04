import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  looksProtected,
  parseModelJson,
  planSignalUpsert,
  toSignalDrafts,
  validateExtraction,
} from '../src/extraction-schema.ts';
import type { StoredSignal } from '../src/extraction-schema.ts';
import { cfg } from './helpers.ts';

const c = cfg();

function feat(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'offer',
    sector: 'agriculture',
    axis_hint: 'execution',
    value: 'drip irrigation installs',
    evidence_ref: 'https://example.org/posts/123',
    confidence: 0.8,
    language: 'en',
    ...over,
  };
}

test('valid features are accepted', () => {
  const r = validateExtraction({ features: [feat(), feat({ type: 'need', sector: null, axis_hint: null })] }, c);
  assert.equal(r.accepted.length, 2);
  assert.equal(r.received, 2);
  assert.ok(Object.values(r.rejected).every((n) => n === 0));
});

test('ALLOWLIST: protected-attribute-like types are rejected and counted', () => {
  const r = validateExtraction(
    {
      features: [
        feat({ type: 'religion', value: 'attends services' }),
        feat({ type: 'ethnicity', value: 'n/a' }),
        feat({ type: 'political_affiliation', value: 'n/a' }),
        feat({ type: 'sexual_orientation', value: 'n/a' }),
        feat({ type: 'health_condition', value: 'n/a' }),
        feat({ type: 'affiliation', value: 'Yoruba cultural union' }),
        feat({ type: 'community_role', value: 'church youth leader' }),
        feat({ type: 'affiliation', value: 'ODM youth wing' }),
        feat({ type: 'purpose', value: 'living with HIV advocacy' }),
        feat({ type: 'affiliation', value: 'women in agribusiness network' }),
        feat(),
      ],
    },
    c,
  );
  assert.equal(r.accepted.length, 1);
  assert.equal(r.rejected.protected_attribute, 10);
});

test('unknown types, long values, missing refs, bad enums are rejected with reasons', () => {
  const r = validateExtraction(
    {
      features: [
        feat({ type: 'skill' }),
        feat({ value: 'x'.repeat(161) }),
        feat({ evidence_ref: undefined }),
        feat({ evidence_ref: '' }),
        feat({ evidence_ref: 'not a ref!' }),
        feat({ sector: 'mining' }),
        feat({ axis_hint: 'charisma' }),
        feat({ confidence: 1.5 }),
        feat({ language: 'fr' }),
        feat({ extra: 'x' }),
        feat({ value: '   ' }),
        'string',
      ],
    },
    c,
  );
  assert.equal(r.accepted.length, 0);
  assert.deepEqual(
    Object.fromEntries(Object.entries(r.rejected).filter(([, n]) => n > 0)),
    {
      unknown_type: 1,
      value_too_long: 1,
      missing_evidence_ref: 2,
      invalid_evidence_ref: 1,
      invalid_sector: 1,
      invalid_axis: 1,
      invalid_confidence: 1,
      invalid_language: 1,
      unknown_field: 1,
      empty_value: 1,
      malformed: 1,
    },
  );
});

test('value of exactly 160 chars is accepted', () => {
  assert.equal(validateExtraction({ features: [feat({ value: 'a'.repeat(160) })] }, c).accepted.length, 1);
});

test('direct messages and private groups are never valid sources', () => {
  const refs = [
    'https://x.com/messages/123',
    'https://www.facebook.com/groups/999/posts/1',
    'https://chat.whatsapp.com/AbC',
    'https://t.me/+abcdef',
    'https://www.instagram.com/direct/t/1',
  ];
  const r = validateExtraction({ features: refs.map((evidence_ref) => feat({ evidence_ref })) }, c);
  assert.equal(r.accepted.length, 0);
  assert.equal(r.rejected.private_source, refs.length);
});

test('malformed roots yield nothing and never throw', () => {
  for (const raw of [null, [], 'x', { features: 'x' }, { features: [], note: 'hi' }]) {
    const r = validateExtraction(raw, c);
    assert.equal(r.accepted.length, 0);
    assert.equal(r.rejected.malformed, 1);
  }
});

test('protected lexicon is word-bounded', () => {
  assert.equal(looksProtected('mentorship for farmers'), false); // contains "men"
  assert.equal(looksProtected('Ministry of Agriculture extension'), false);
  assert.equal(looksProtected('Churchill Road market'), false);
  assert.equal(looksProtected('Pentecostal choir'), true);
  assert.equal(looksProtected('kalenjin elders'), true);
});

test('parseModelJson handles fences and garbage', () => {
  assert.deepEqual(parseModelJson('```json\n{"features":[]}\n```'), { features: [] });
  assert.equal(parseModelJson('not json'), null);
});

test('signals are always claimed; unvalidated languages get half weight', () => {
  const r = validateExtraction(
    { features: [feat(), feat({ language: 'sw', evidence_ref: 'post:9' }), feat({ language: 'pcm', evidence_ref: 'post:10' })] },
    c,
  );
  const drafts = toSignalDrafts(r.accepted, { person_id: 'p1', source: 'x' }, c);
  assert.ok(drafts.every((d) => d.status === 'claimed'));
  assert.deepEqual(drafts.map((d) => d.weight), [1, 0.5, 0.5]);
});

test('IDEMPOTENCY: re-ingesting the same evidence_ref creates no duplicates', () => {
  const ingest = (raw: unknown) =>
    toSignalDrafts(validateExtraction(raw, c).accepted, { person_id: 'p1', source: 'x' }, c);
  const first = ingest({ features: [feat(), feat({ type: 'sector_interest', value: 'agriculture' })] });
  const plan1 = planSignalUpsert([], first);
  assert.equal(plan1.insert.length, 2);

  let n = 0;
  const stored: StoredSignal[] = plan1.insert.map((d) => ({ ...d, id: `s${++n}` }));
  // Same content again (and duplicated inside the batch): nothing new.
  const again = ingest({ features: [feat(), feat(), feat({ type: 'sector_interest', value: 'Agriculture ' })] });
  const plan2 = planSignalUpsert(stored, again);
  assert.deepEqual([plan2.insert.length, plan2.update.length, plan2.delete.length, plan2.unchanged], [0, 0, 0, 2]);

  // Re-extraction rewords one feature: replaced, not duplicated.
  const reworded = ingest({ features: [feat({ value: 'drip irrigation installation' }), feat({ type: 'sector_interest', value: 'agriculture' })] });
  const plan3 = planSignalUpsert(stored, reworded);
  assert.equal(plan3.insert.length, 1);
  assert.equal(plan3.delete.length, 1);
  assert.equal(stored.length - plan3.delete.length + plan3.insert.length, 2);

  // Confidence change updates in place.
  const conf = ingest({ features: [feat({ confidence: 0.95 }), feat({ type: 'sector_interest', value: 'agriculture' })] });
  const plan4 = planSignalUpsert(stored, conf);
  assert.deepEqual([plan4.insert.length, plan4.update.length, plan4.delete.length], [0, 1, 0]);

  // Signals from other evidence refs are untouched.
  const other = ingest({ features: [feat({ evidence_ref: 'post:77' })] });
  assert.equal(planSignalUpsert(stored, other).delete.length, 0);
});
