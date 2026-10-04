// Extraction output contract (spec 5.4). The LLM's JSON is untrusted: everything is validated
// against an allowlist and anything else is discarded and counted (never logged with content).

import { AXES } from './config.ts';
import type { Axis, ResolvedConfig } from './config.ts';
import { normaliseValue } from './scoring.ts';
import { PROTECTED_TERMS } from './data/protected-terms.ts';

export const FEATURE_TYPES = ['sector_interest', 'affiliation', 'community_role', 'offer', 'need', 'purpose'] as const;
export type FeatureType = (typeof FEATURE_TYPES)[number];

export const EXTRACTION_LANGUAGES = ['en', 'sw', 'pcm', 'yo', 'other'] as const;
export type ExtractionLanguage = (typeof EXTRACTION_LANGUAGES)[number];

export interface ExtractedFeature {
  type: FeatureType;
  sector: string | null;
  axis_hint: Axis | null;
  value: string;
  evidence_ref: string;
  confidence: number;
  language: ExtractionLanguage;
}

export const REJECT_REASONS = [
  'malformed',
  'unknown_field',
  'unknown_type',
  'protected_attribute',
  'private_source',
  'missing_evidence_ref',
  'invalid_evidence_ref',
  'empty_value',
  'value_too_long',
  'invalid_sector',
  'invalid_axis',
  'invalid_confidence',
  'invalid_language',
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export interface ExtractionResult {
  accepted: ExtractedFeature[];
  /** Counts only. Never content. */
  rejected: Record<RejectReason, number>;
  received: number;
}

const FEATURE_KEYS = ['type', 'sector', 'axis_hint', 'value', 'evidence_ref', 'confidence', 'language'] as const;

// Protected terms live in ./data/protected-terms.ts (data only; see DECISIONS D-016).
function termRegex(terms: readonly string[]): RegExp {
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s_-]+'));
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${escaped.join('|')})(?:$|[^\\p{L}\\p{N}])`, 'iu');
}
const PROTECTED_RE = termRegex(PROTECTED_TERMS);

/** Direct messages and private groups must never be sources. */
const PRIVATE_SOURCE_RE =
  /(\/messages?\/|\/direct\/|\/dm\/|\/inbox\/|\/groups?\/|chat\.whatsapp\.com|wa\.me\/|t\.me\/(\+|joinchat)|t\.me\/c\/|\/chat\/|private)/i;

const POST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_.\-]{0,199}$/;

export function looksProtected(text: string): boolean {
  return PROTECTED_RE.test(text.normalize('NFKC'));
}

function evidenceRefKind(ref: string): 'ok' | 'private' | 'invalid' {
  if (PRIVATE_SOURCE_RE.test(ref)) return 'private';
  if (/^https:\/\/[^\s]{1,500}$/.test(ref)) {
    try {
      new URL(ref);
      return 'ok';
    } catch {
      return 'invalid';
    }
  }
  return POST_ID_RE.test(ref) ? 'ok' : 'invalid';
}

function emptyCounts(): Record<RejectReason, number> {
  const out = {} as Record<RejectReason, number>;
  for (const r of REJECT_REASONS) out[r] = 0;
  return out;
}

function checkFeature(
  f: unknown,
  sectors: ReadonlySet<string>,
  maxLen: number,
): { ok: true; feature: ExtractedFeature } | { ok: false; reason: RejectReason } {
  if (typeof f !== 'object' || f === null || Array.isArray(f)) return { ok: false, reason: 'malformed' };
  const o = f as Record<string, unknown>;
  const type = o['type'];
  const value = o['value'];
  // Protected check runs first, on every string field, so it is counted even for unknown types.
  for (const v of [type, value, o['sector']]) {
    if (typeof v === 'string' && looksProtected(v)) return { ok: false, reason: 'protected_attribute' };
  }
  for (const k of Object.keys(o)) {
    if (!(FEATURE_KEYS as readonly string[]).includes(k)) return { ok: false, reason: 'unknown_field' };
  }
  if (typeof type !== 'string' || !(FEATURE_TYPES as readonly string[]).includes(type)) {
    return { ok: false, reason: 'unknown_type' };
  }
  const ref = o['evidence_ref'];
  if (typeof ref !== 'string' || ref.trim() === '') return { ok: false, reason: 'missing_evidence_ref' };
  const refKind = evidenceRefKind(ref.trim());
  if (refKind === 'private') return { ok: false, reason: 'private_source' };
  if (refKind === 'invalid') return { ok: false, reason: 'invalid_evidence_ref' };
  if (typeof value !== 'string' || value.trim() === '') return { ok: false, reason: 'empty_value' };
  if (value.length > maxLen) return { ok: false, reason: 'value_too_long' };
  const sector = o['sector'] ?? null;
  if (sector !== null && (typeof sector !== 'string' || !sectors.has(sector))) {
    return { ok: false, reason: 'invalid_sector' };
  }
  const axis = o['axis_hint'] ?? null;
  if (axis !== null && (typeof axis !== 'string' || !(AXES as readonly string[]).includes(axis))) {
    return { ok: false, reason: 'invalid_axis' };
  }
  const conf = o['confidence'];
  if (typeof conf !== 'number' || !Number.isFinite(conf) || conf < 0 || conf > 1) {
    return { ok: false, reason: 'invalid_confidence' };
  }
  const lang = o['language'];
  if (typeof lang !== 'string' || !(EXTRACTION_LANGUAGES as readonly string[]).includes(lang)) {
    return { ok: false, reason: 'invalid_language' };
  }
  return {
    ok: true,
    feature: {
      type: type as FeatureType,
      sector: sector as string | null,
      axis_hint: axis as Axis | null,
      value: value.trim(),
      evidence_ref: ref.trim(),
      confidence: conf,
      language: lang as ExtractionLanguage,
    },
  };
}

/** Validate raw model output. Never throws; malformed input yields zero accepted features. */
export function validateExtraction(
  raw: unknown,
  cfg: Pick<ResolvedConfig, 'sectors' | 'extraction'>,
): ExtractionResult {
  const rejected = emptyCounts();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    rejected.malformed = 1;
    return { accepted: [], rejected, received: 0 };
  }
  const root = raw as Record<string, unknown>;
  const features = root['features'];
  if (!Array.isArray(features) || Object.keys(root).some((k) => k !== 'features')) {
    rejected.malformed = 1;
    return { accepted: [], rejected, received: Array.isArray(features) ? features.length : 0 };
  }
  const sectors = new Set(cfg.sectors);
  const accepted: ExtractedFeature[] = [];
  for (const f of features) {
    const r = checkFeature(f, sectors, cfg.extraction.max_value_length);
    if (r.ok) accepted.push(r.feature);
    else rejected[r.reason] += 1;
  }
  return { accepted, rejected, received: features.length };
}

/** Parse a model's text response (JSON, optionally inside a ```json fence). */
export function parseModelJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  try {
    return JSON.parse((fenced?.[1] ?? text).trim());
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Signals: what gets stored (derived features only, never raw content)
// ---------------------------------------------------------------------------

export interface SignalDraft {
  person_id: string;
  source: string;
  idem_key: string;
  evidence_ref: string;
  feature_type: FeatureType;
  sector: string | null;
  axis: Axis | null;
  value: string;
  confidence: number;
  language: ExtractionLanguage;
  /** Social-derived and self-declared signals are always `claimed` (stingy rule). */
  status: 'claimed';
  weight: number;
}

export interface StoredSignal extends SignalDraft {
  id: string;
}

export function signalIdemKey(
  source: string,
  f: Pick<ExtractedFeature, 'evidence_ref' | 'type' | 'sector' | 'axis_hint' | 'value'>,
): string {
  return [source, f.evidence_ref, f.type, f.sector ?? '-', f.axis_hint ?? '-', normaliseValue(f.value)].join('|');
}

export function toSignalDrafts(
  features: readonly ExtractedFeature[],
  ctx: { person_id: string; source: string },
  cfg: Pick<ResolvedConfig, 'extraction'>,
): SignalDraft[] {
  const validated = new Set(cfg.extraction.validated_languages);
  const byKey = new Map<string, SignalDraft>();
  for (const f of features) {
    const draft: SignalDraft = {
      person_id: ctx.person_id,
      source: ctx.source,
      idem_key: signalIdemKey(ctx.source, f),
      evidence_ref: f.evidence_ref,
      feature_type: f.type,
      sector: f.sector,
      axis: f.axis_hint,
      value: normaliseValue(f.value),
      confidence: f.confidence,
      language: f.language,
      status: 'claimed',
      weight: validated.has(f.language) ? 1 : cfg.extraction.unvalidated_language_weight,
    };
    const prev = byKey.get(draft.idem_key);
    if (prev === undefined || draft.confidence > prev.confidence) byKey.set(draft.idem_key, draft);
  }
  return [...byKey.values()];
}

export interface UpsertPlan {
  insert: SignalDraft[];
  update: Array<{ id: string; draft: SignalDraft }>;
  /** Ids of stored signals for a re-ingested evidence_ref that the new extraction no longer yields. */
  delete: string[];
  unchanged: number;
}

/**
 * Idempotent upsert: an evidence_ref's feature set is replaced, never duplicated.
 * `existing` must be the person's stored signals for the same source.
 */
export function planSignalUpsert(existing: readonly StoredSignal[], incoming: readonly SignalDraft[]): UpsertPlan {
  const refs = new Set(incoming.map((d) => d.evidence_ref));
  const stored = new Map(existing.map((s) => [s.idem_key, s]));
  const plan: UpsertPlan = { insert: [], update: [], delete: [], unchanged: 0 };
  const seen = new Set<string>();
  for (const d of incoming) {
    if (seen.has(d.idem_key)) continue;
    seen.add(d.idem_key);
    const s = stored.get(d.idem_key);
    if (s === undefined) plan.insert.push(d);
    else if (s.confidence !== d.confidence || s.weight !== d.weight || s.language !== d.language) {
      plan.update.push({ id: s.id, draft: d });
    } else plan.unchanged += 1;
  }
  for (const s of existing) {
    if (refs.has(s.evidence_ref) && !seen.has(s.idem_key)) plan.delete.push(s.id);
  }
  return plan;
}
