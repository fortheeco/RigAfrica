// End-to-end evaluation: generate synthetic data, run the pal-core pipeline, compute metrics and
// the fairness audit, and write JSON reports the UI can read via pal-api (GET /admin/fairness).
//
//   node src/run.ts [--seed N] [--members-per-place N] [--out DIR] [--config PATH]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { validateConfig } from '../../packages/pal-core/src/config.ts';
import type { PalConfig } from '../../packages/pal-core/src/config.ts';
import { trBand } from '../../packages/pal-core/src/readiness.ts';
import { DEFAULT_GENERATE_OPTIONS, generateDataset } from './generate.ts';
import type { Fixtures, GenerateOptions } from './generate.ts';
import { simulate } from './simulate.ts';
import type { SimulationRun } from './simulate.ts';
import { completionLift, mapStability, precisionAtK, roleCalibration } from './metrics.ts';
import { fairnessAudit } from './fairness.ts';
import type { FairnessReport } from './fairness.ts';
import { languageGate, loadLabelled } from './language-gate.ts';
import type { GateResult } from './language-gate.ts';

const HERE = new URL('..', import.meta.url).pathname;
const REPO = resolve(HERE, '..');

export function loadConfig(path = join(REPO, 'config/pal.config.yaml')): PalConfig {
  const r = validateConfig(parse(readFileSync(path, 'utf8')));
  if (!r.ok) throw new Error(`invalid config: ${JSON.stringify(r.issues)}`);
  return r.config;
}

export function loadFixtures(path = join(HERE, 'fixtures/places.json')): Fixtures {
  return JSON.parse(readFileSync(path, 'utf8')) as Fixtures;
}

export interface EvalReport {
  generated_at: string;
  seed: number;
  model_version: string;
  dataset: { members: number; places: number; sparks: number; evidence: number; claimed: number };
  metrics: {
    role_calibration: ReturnType<typeof roleCalibration>;
    precision_at_k: ReturnType<typeof precisionAtK>;
    completion_lift: ReturnType<typeof completionLift>;
    map_stability: ReturnType<typeof mapStability>;
  };
  sparks: { blocked_by_verifier_gate: number; without_trios: number };
  languages: GateResult[];
}

export interface EvalOutput {
  run: SimulationRun;
  report: EvalReport;
  fairness: FairnessReport;
  outcomes: Array<Record<string, unknown>>;
}

export function runEval(
  config: PalConfig,
  fixtures: Fixtures,
  opts: GenerateOptions = DEFAULT_GENERATE_OPTIONS,
  extra: { generated_at?: string; labelled_dir?: string } = {},
): EvalOutput {
  const generated_at = extra.generated_at ?? new Date().toISOString();
  const ds = generateDataset(config, fixtures, opts);
  const run = simulate(config, ds);
  const k = run.instances[0]?.cfg.matching.max_trios ?? 3;
  const metrics = {
    role_calibration: roleCalibration(run),
    precision_at_k: precisionAtK(run, k),
    completion_lift: completionLift(run),
    map_stability: mapStability(run, trBand),
  };
  const languages = [...new Set(config.instances.flatMap((i) => i.languages))]
    .sort()
    .map((lang) => languageGate(lang, loadLabelled(extra.labelled_dir ?? join(HERE, 'labelled'), lang)));
  const allSparks = run.instances.flatMap((i) => i.sparks);
  const report: EvalReport = {
    generated_at,
    seed: ds.seed,
    model_version: config.model_version,
    dataset: {
      members: ds.members.length,
      places: ds.places.length,
      sparks: ds.sparks.length,
      evidence: ds.members.reduce((s, m) => s + m.evidence.length, 0),
      claimed: ds.members.reduce((s, m) => s + m.claimed.length, 0),
    },
    metrics,
    sparks: {
      blocked_by_verifier_gate: allSparks.filter((s) => s.active_verifiers < (run.instances[0]?.cfg.sparks.min_active_verifiers ?? 1)).length,
      without_trios: allSparks.filter((s) => s.result.trios.length === 0).length,
    },
    languages,
  };
  const fairness = fairnessAudit(run, { generated_at, dataset: 'synthetic' });
  fairness.metrics = metrics;
  // spark_outcomes rows (Stage C training data shape); synthetic here, live rows come from spark-settle.
  const outcomes = allSparks
    .filter((s) => s.completed !== null && s.result.trios[0] !== undefined)
    .map((s) => ({
      spark_id: s.seed.spark_id,
      instance_id: s.seed.instance_id,
      place_id: s.seed.place_id,
      sector: s.seed.sector,
      duration_days: s.seed.duration_days,
      trio: s.result.trios[0]?.members.map((m) => ({
        person_id: m.person_id,
        role: m.role,
        verified_score: m.verified_score,
        claimed_score: m.claimed_score,
        confidence: m.confidence,
        cluster: m.cluster,
        ...m.components,
      })),
      trio_score: s.result.trios[0]?.score,
      distinct_clusters: s.result.trios[0]?.distinct_clusters,
      completed: s.completed,
      model_version: config.model_version,
      dataset: 'synthetic',
    }));
  return { run, report, fairness, outcomes };
}

export function writeOutputs(out: EvalOutput, dir: string): string[] {
  mkdirSync(dir, { recursive: true });
  const files = {
    'eval-report.json': JSON.stringify(out.report, null, 2),
    'fairness-report.json': JSON.stringify(out.fairness, null, 2),
    'spark_outcomes.jsonl': out.outcomes.map((o) => JSON.stringify(o)).join('\n') + '\n',
  };
  return Object.entries(files).map(([name, body]) => {
    const p = join(dir, name);
    writeFileSync(p, body);
    return p;
  });
}

function main(): void {
  const { values } = parseArgs({
    options: {
      seed: { type: 'string' },
      'members-per-place': { type: 'string' },
      out: { type: 'string' },
      config: { type: 'string' },
    },
  });
  const opts: GenerateOptions = {
    ...DEFAULT_GENERATE_OPTIONS,
    seed: values.seed === undefined ? DEFAULT_GENERATE_OPTIONS.seed : Number(values.seed),
    members_per_place: values['members-per-place'] === undefined ? DEFAULT_GENERATE_OPTIONS.members_per_place : Number(values['members-per-place']),
  };
  const out = runEval(loadConfig(values.config), loadFixtures(), opts);
  const files = writeOutputs(out, values.out ?? join(HERE, 'out'));
  const m = out.report.metrics;
  const fmt = (x: number | null) => (x === null ? 'n/a' : x.toFixed(3));
  process.stdout.write(
    [
      `members=${out.report.dataset.members} places=${out.report.dataset.places} sparks=${out.report.dataset.sparks}`,
      `role precision P/A/L=${fmt(m.role_calibration.per_role.Partner.precision)}/${fmt(m.role_calibration.per_role.Ambassador.precision)}/${fmt(m.role_calibration.per_role.Leader.precision)} ece=${fmt(m.role_calibration.ece)}`,
      `precision@${m.precision_at_k.k}=${fmt(m.precision_at_k.precision)} completion lift=${fmt(m.completion_lift.lift)} (proposed ${fmt(m.completion_lift.mean_p_proposed)} vs random ${fmt(m.completion_lift.mean_p_random)})`,
      `map drift 30d mean=${fmt(m.map_stability.mean_abs_tr_change_30d)} band change rate=${fmt(m.map_stability.band_change_rate_30d)}`,
      `fairness overall footprint gap=${String(out.fairness.footprint.overall.median_gap)} flags=${out.fairness.flags.length}`,
      `languages validated: ${out.report.languages.filter((l) => l.validated).map((l) => l.language).join(', ') || 'none'}`,
      ...files.map((f) => `wrote ${f}`),
    ].join('\n') + '\n',
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
