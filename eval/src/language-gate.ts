// Language validation gate (spec §6.4). Ships the loader and the gate, not the data.
// A language is validated only when precision on `sector_interest` AND `affiliation` is >= 0.8,
// each measured on at least 100 human-labelled extraction outputs.
//
// File format: eval/labelled/<lang>.jsonl (gitignored), one JSON object per line:
//   {"id":"…","language":"sw","feature_type":"sector_interest","correct":true}
// `correct` is the human label: was the extracted feature right for its evidence?

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const GATED_TYPES = ['sector_interest', 'affiliation'] as const;
export const MIN_ITEMS_PER_TYPE = 100;
export const MIN_PRECISION = 0.8;

export interface LabelledItem {
  id: string;
  language: string;
  feature_type: string;
  correct: boolean;
}

export interface LoadResult {
  items: LabelledItem[];
  invalid_lines: number;
}

export function parseLabelled(text: string, language: string): LoadResult {
  const items: LabelledItem[] = [];
  let invalid = 0;
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      if (typeof o['id'] !== 'string' || o['language'] !== language || typeof o['feature_type'] !== 'string' || typeof o['correct'] !== 'boolean' || seen.has(o['id'])) {
        invalid += 1;
        continue;
      }
      seen.add(o['id']);
      items.push({ id: o['id'], language, feature_type: o['feature_type'], correct: o['correct'] });
    } catch {
      invalid += 1;
    }
  }
  return { items, invalid_lines: invalid };
}

export function loadLabelled(dir: string, language: string): LoadResult | null {
  const file = join(dir, `${language}.jsonl`);
  return existsSync(file) ? parseLabelled(readFileSync(file, 'utf8'), language) : null;
}

export interface GateResult {
  language: string;
  validated: boolean;
  reason: 'passed' | 'no_data' | 'insufficient_items' | 'low_precision';
  per_type: Record<string, { n: number; precision: number | null }>;
}

export function languageGate(language: string, data: LoadResult | null): GateResult {
  const per_type: GateResult['per_type'] = {};
  for (const t of GATED_TYPES) {
    const xs = data?.items.filter((i) => i.feature_type === t) ?? [];
    per_type[t] = { n: xs.length, precision: xs.length === 0 ? null : xs.filter((i) => i.correct).length / xs.length };
  }
  if (data === null || data.items.length === 0) return { language, validated: false, reason: 'no_data', per_type };
  if (GATED_TYPES.some((t) => (per_type[t]?.n ?? 0) < MIN_ITEMS_PER_TYPE)) return { language, validated: false, reason: 'insufficient_items', per_type };
  if (GATED_TYPES.some((t) => (per_type[t]?.precision ?? 0) < MIN_PRECISION)) return { language, validated: false, reason: 'low_precision', per_type };
  return { language, validated: true, reason: 'passed', per_type };
}
