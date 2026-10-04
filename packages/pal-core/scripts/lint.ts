// Lint rules tsc does not enforce. Exits non-zero on any finding.
//  - no `any` type in pal-core src (spec: strict TypeScript, no `any`)
//  - no console.* in pal-core src (core is pure; logging belongs to callers, ids and counts only)
//  - no Date.now()/new Date() without argument in src (time is always passed in, for testability)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../src/', import.meta.url).pathname;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const rules: Array<[string, RegExp]> = [
  ['no-explicit-any', /(:\s*any\b|\bas\s+any\b|<any>|\bany\[\]|Array<any>|Record<[^>]*\bany\b)/],
  ['no-console', /\bconsole\./],
  ['no-ambient-clock', /\bDate\.now\(\)|new Date\(\)/],
];

let findings = 0;
for (const file of walk(root)) {
  const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
  lines.forEach((line, i) => {
    for (const [name, re] of rules) {
      if (re.test(line)) {
        findings += 1;
        process.stderr.write(`${file}:${i + 1}: ${name}: ${line.trim()}\n`);
      }
    }
  });
}
if (findings > 0) process.exit(1);
process.stdout.write('lint: ok\n');
