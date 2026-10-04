// Repo-wide static guards. They scan every PAL code path, including directories that do not
// exist yet (supabase/functions, supabase/migrations), so new code is covered automatically.
//
//  - SEPARATION: no PAL code writes to, alters, or triggers on a table that is not pal_* / spark*.
//  - CONFIG: no instance id from config/pal.config.yaml appears in code (no `if instance == ...`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';

const ROOT = new URL('../../../', import.meta.url).pathname;

/** Calls into existing ECO code that PAL is allowed to trigger (spec 5.7: reuse, do not rebuild). */
export const ALLOWED_EXTERNAL_CALLS: readonly string[] = [
  // Filled in once eco-civic-console is visible, e.g. the existing milestone-gated release RPC.
];

const CODE_DIRS = ['packages/pal-core/src', 'supabase/functions', 'supabase/migrations', 'eval', 'ml'];
const EXCLUDE = [/\/node_modules\//, /\/fixtures\//, /\/src\/data\//, /\/out\//, /\/tests?\//, /\.test\.ts$/, /__pycache__/];

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|js|mjs|sql|py)$/.test(p) ? [p] : [];
  });
}

function codeFiles(): string[] {
  return CODE_DIRS.flatMap((d) => walk(join(ROOT, d))).filter((p) => {
    if (EXCLUDE.some((re) => re.test(p))) return false;
    // Only PAL migrations are ours; other migrations belong to the platform.
    if (p.includes('supabase/migrations/') && !/_pal_|_spark_/.test(p)) return false;
    return true;
  });
}

export function stripComments(src: string, file: string): string {
  if (file.endsWith('.py')) return src.replace(/#.*$/gm, '').replace(/"""[\s\S]*?"""/g, '');
  if (file.endsWith('.sql')) return src.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

const OURS = /^(pal_|spark)/;
const IDENT = String.raw`(?:"?([a-z_][a-z0-9_]*)"?\.)?"?([a-z_][a-z0-9_]*)"?`;

export interface Violation {
  file: string;
  kind: string;
  target: string;
}

export function scanSeparation(src: string, file: string): Violation[] {
  const code = stripComments(src, file);
  const out: Violation[] = [];
  const add = (kind: string, schema: string | undefined, table: string | undefined) => {
    if (table === undefined) return;
    const t = table.toLowerCase();
    if (OURS.test(t)) return;
    if (schema !== undefined && schema.toLowerCase() === 'pg_temp') return;
    out.push({ file, kind, target: schema !== undefined ? `${schema}.${t}` : t });
  };
  const sqlPatterns: Array<[string, RegExp]> = [
    ['insert', new RegExp(String.raw`\binsert\s+into\s+${IDENT}`, 'gi')],
    ['update', new RegExp(String.raw`\bupdate\s+(?:only\s+)?${IDENT}\s+set\b`, 'gi')],
    ['delete', new RegExp(String.raw`\bdelete\s+from\s+(?:only\s+)?${IDENT}`, 'gi')],
    ['alter', new RegExp(String.raw`\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${IDENT}`, 'gi')],
    ['drop', new RegExp(String.raw`\bdrop\s+table\s+(?:if\s+exists\s+)?${IDENT}`, 'gi')],
    ['truncate', new RegExp(String.raw`\btruncate\s+(?:table\s+)?${IDENT}`, 'gi')],
    ['trigger_on', new RegExp(String.raw`\bcreate\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\b[\s\S]*?\bon\s+${IDENT}`, 'gi')],
    ['merge', new RegExp(String.raw`\bmerge\s+into\s+${IDENT}`, 'gi')],
  ];
  for (const [kind, re] of sqlPatterns) for (const m of code.matchAll(re)) add(kind, m[1], m[2]);

  if (/\.(ts|js|mjs)$/.test(file)) {
    // supabase-js: .from('table') ... .insert/.update/.upsert/.delete( within the same chain.
    const chain = /\.from\(\s*['"`]([^'"`]+)['"`]\s*\)((?:\s*\.\w+\((?:[^()]|\([^()]*\))*\))*)/g;
    for (const m of code.matchAll(chain)) {
      const tail = m[2] ?? '';
      const w = /\.(insert|update|upsert|delete)\s*\(/.exec(tail);
      if (w !== null) add(`js_${w[1]}`, undefined, m[1]);
    }
    for (const m of code.matchAll(/\.rpc\(\s*['"`]([^'"`]+)['"`]/g)) {
      const fn = m[1] as string;
      if (!OURS.test(fn) && !ALLOWED_EXTERNAL_CALLS.includes(fn)) out.push({ file, kind: 'rpc', target: fn });
    }
    for (const m of code.matchAll(/functions\.invoke\(\s*['"`]([^'"`]+)['"`]/g)) {
      const fn = m[1] as string;
      if (!/^(pal-|spark-)/.test(fn) && fn !== 'eco-id-resolve' && !ALLOWED_EXTERNAL_CALLS.includes(fn)) {
        out.push({ file, kind: 'invoke', target: fn });
      }
    }
  }
  return out;
}

test('SEPARATION scanner catches violations (self-test)', () => {
  const sql = [
    'insert into civic_score (person_id) values (1);',
    'UPDATE public.eco_vitality SET x = 1;',
    'delete from eco_events where id = 1;',
    'alter table public.profiles add column pal_x int;',
    'create trigger t after insert on eco_events for each row execute function pal_enqueue();',
    'insert into pal_signals values (1); update spark_invites set x = 1; delete from pal_edges;',
    '-- insert into civic_score values (1);',
  ].join('\n');
  const v = scanSeparation(sql, 'x_pal_test.sql').map((x) => `${x.kind}:${x.target}`);
  assert.deepEqual(v, ['insert:civic_score', 'update:public.eco_vitality', 'delete:eco_events', 'alter:public.profiles', 'trigger_on:eco_events']);

  const ts = [
    "await db.from('civic_score').update({ v: 1 }).eq('id', id);",
    "await db.from('eco_events').select('*').eq('x', 1);",
    "await db.from('pal_profiles').upsert(rows);",
    "await db.from(\"eco_vitality\")\n  .insert({ a: 1 });",
    "await db.rpc('recalc_civic_score', {});",
    "await db.rpc('pal_recompute', {});",
    "await db.functions.invoke('payout-release', {});",
  ].join('\n');
  const t = scanSeparation(ts, 'f.ts').map((x) => `${x.kind}:${x.target}`);
  assert.deepEqual(t, ['js_update:civic_score', 'js_insert:eco_vitality', 'rpc:recalc_civic_score', 'invoke:payout-release']);
});

test('SEPARATION: no PAL code path writes to civic_score, eco_vitality or any non-PAL table', () => {
  const files = codeFiles();
  assert.ok(files.length > 0);
  const violations = files.flatMap((f) => scanSeparation(readFileSync(f, 'utf8'), relative(ROOT, f)));
  assert.deepEqual(violations, []);
});

test('data-only modules (src/data) contain no control flow', () => {
  const dir = join(ROOT, 'packages/pal-core/src/data');
  for (const f of walk(dir)) {
    const code = stripComments(readFileSync(f, 'utf8'), f);
    assert.doesNotMatch(code, /\b(if|else|switch|case|for|while|function|return|=>|import|class)\b|=>/, relative(ROOT, f));
    assert.match(code, /^\s*export const [A-Z_]+: readonly string\[\] = \[/m);
  }
});

test('CONFIG: no instance id from config appears in code paths', () => {
  const config = parse(readFileSync(join(ROOT, 'config/pal.config.yaml'), 'utf8')) as { instances: Array<{ id: string }> };
  const ids = config.instances.map((i) => i.id);
  // Retired or never-launched places must not creep back in either (spec §1: not Warri).
  const banned = [...ids, 'warri'];
  const re = new RegExp(String.raw`\b(${banned.join('|')})\b`, 'i');
  const hits: string[] = [];
  for (const f of codeFiles()) {
    stripComments(readFileSync(f, 'utf8'), f)
      .split('\n')
      .forEach((line, i) => {
        if (re.test(line)) hits.push(`${relative(ROOT, f)}:${i + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(hits, []);
});
