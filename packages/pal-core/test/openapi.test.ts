// Contract checks for docs/pal-api.openapi.yaml: every spec §7 route exists, every $ref resolves,
// every operation is typed, and enums stay in sync with pal-core.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { REJECT_REASONS, FEATURE_TYPES } from '../src/extraction-schema.ts';
import { SPARK_STATUSES } from '../src/sparks.ts';
import type { SparkGateError } from '../src/sparks.ts';

type Doc = Record<string, unknown>;
const doc = parse(readFileSync(new URL('../../../docs/pal-api.openapi.yaml', import.meta.url), 'utf8')) as Doc;

const REQUIRED: Array<[string, string]> = [
  ['get', '/me/profile'], ['post', '/me/evidence/{id}/dispute'],
  ['get', '/me/consents'], ['post', '/me/consents'], ['delete', '/me/consents/{source}'],
  ['get', '/me/learned'], ['get', '/me/export'], ['delete', '/me'],
  ['get', '/map'], ['get', '/map/gaps'], ['get', '/map/brokers'],
  ['get', '/sparks'], ['post', '/sparks'], ['post', '/sparks/{id}/approve'],
  ['get', '/sparks/{id}/matches'], ['post', '/sparks/{id}/matches/{m}/invite'],
  ['post', '/sparks/{id}/accept'], ['post', '/sparks/{id}/decline'], ['post', '/sparks/{id}/settle'],
  ['get', '/admin/config'], ['put', '/admin/config'],
  ['get', '/admin/fairness'], ['get', '/admin/disputes'], ['get', '/admin/access-log'],
];

function get(path: string): unknown {
  return path.replace(/^#\//, '').split('/').reduce<unknown>((o, k) => (o as Doc | undefined)?.[k.replace(/~1/g, '/')], doc);
}

test('every spec §7 route is in the contract with an operationId, scopes and a default error', () => {
  const paths = doc['paths'] as Record<string, Record<string, Doc>>;
  for (const [method, path] of REQUIRED) {
    const op = paths[path]?.[method];
    assert.ok(op, `${method.toUpperCase()} ${path} missing`);
    assert.equal(typeof op['operationId'], 'string');
    assert.ok(Array.isArray(op['x-pal-scopes']), `${path} has no x-pal-scopes`);
    assert.ok((op['responses'] as Doc)['default'], `${path} has no default error response`);
  }
});

test('every $ref resolves', () => {
  const refs: string[] = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (typeof v === 'object' && v !== null) {
      for (const [k, x] of Object.entries(v)) {
        if (k === '$ref' && typeof x === 'string') refs.push(x);
        else visit(x);
      }
    }
  };
  visit(doc);
  assert.ok(refs.length > 50);
  for (const r of refs) assert.notEqual(get(r), undefined, `unresolved ${r}`);
});

test('list endpoints paginate', () => {
  const paths = doc['paths'] as Record<string, Record<string, Doc>>;
  for (const [path, ops] of Object.entries(paths)) {
    const op = ops['get'];
    if (op === undefined) continue;
    const schema = JSON.stringify((op['responses'] as Doc)['200']);
    if (!schema.includes('#/components/schemas/Page')) continue;
    const params = JSON.stringify(op['parameters'] ?? []);
    assert.ok(params.includes('Cursor') && params.includes('Limit'), `${path} paginates without cursor/limit`);
  }
});

test('enums stay in sync with pal-core', () => {
  const codes = get('#/components/schemas/ErrorCode/enum') as string[];
  const gate: SparkGateError[] = [
    'invalid_duration', 'unknown_sector', 'funding_cap_unset', 'amount_required', 'over_funding_cap',
    'value_split_missing', 'value_split_invalid', 'no_active_verifier', 'not_steward_approved',
    'split_not_locked', 'trio_incomplete', 'invalid_transition',
  ];
  for (const g of [...gate, 'no_consent', 'consent_revoked', 'handle_unverified', 'unknown_instance']) assert.ok(codes.includes(g), g);
  assert.deepEqual(get('#/components/schemas/SparkStatus/enum'), [...SPARK_STATUSES]);
  assert.deepEqual(get('#/components/schemas/LearnedFeature/properties/feature_type/enum'), [...FEATURE_TYPES]);
  assert.ok(REJECT_REASONS.length > 0);
});

test('no stray keys from unquoted commas in flow maps (schema objects use known keywords only)', () => {
  const KNOWN = new Set([
    'type', 'format', 'description', 'enum', 'const', 'items', 'properties', 'required', 'additionalProperties',
    'minimum', 'maximum', 'minItems', 'maxItems', 'maxLength', 'default', 'example', 'oneOf', 'allOf', '$ref',
  ]);
  const visit = (v: unknown, path: string): void => {
    if (Array.isArray(v)) return v.forEach((x, i) => visit(x, `${path}[${i}]`));
    if (typeof v !== 'object' || v === null) return;
    const o = v as Record<string, unknown>;
    const isSchema = /\.schema$|\.schemas\.[^.]+$|\.properties\.[^.]+$|\.items$/.test(path);
    if (isSchema) for (const k of Object.keys(o)) assert.ok(KNOWN.has(k), `${path}: unexpected key "${k}"`);
    for (const [k, x] of Object.entries(o)) visit(x, `${path}.${k}`);
  };
  visit(doc, '$');
});
