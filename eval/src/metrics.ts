// Evaluation metrics (spec §6.2): role calibration vs simulated verifier labels, precision@k of
// trio proposals, Spark completion lift vs random matching, map readiness stability.

import { AXES, ROLE_LABEL } from '../../packages/pal-core/src/config.ts';
import type { Axis, RoleLabel } from '../../packages/pal-core/src/config.ts';
import type { SimulationRun } from './simulate.ts';

export interface CalibrationBin {
  lo: number;
  hi: number;
  n: number;
  mean_confidence: number | null;
  accuracy: number | null;
}

export interface CalibrationReport {
  assessed: number;
  predicted_with_role: number;
  per_role: Record<RoleLabel, { precision: number | null; recall: number | null; predicted: number; labelled: number }>;
  /** Expected calibration error of role-confidence vs verifier agreement. */
  ece: number | null;
  bins: CalibrationBin[];
}

function ratio(a: number, b: number): number | null {
  return b === 0 ? null : a / b;
}

export function roleCalibration(run: SimulationRun): CalibrationReport {
  const per = {} as Record<Axis, { tp: number; predicted: number; labelled: number }>;
  for (const a of AXES) per[a] = { tp: 0, predicted: 0, labelled: 0 };
  const bins = Array.from({ length: 10 }, (_, i) => ({ lo: i / 10, hi: (i + 1) / 10, n: 0, conf: 0, correct: 0 }));
  let assessed = 0;
  let predicted = 0;
  for (const inst of run.instances) {
    for (const { member, profile } of inst.members) {
      for (const [sector, label] of Object.entries(member.verifier_label)) {
        assessed += 1;
        if (label !== 'none') per[label].labelled += 1;
        const sp = profile.sectors.find((s) => s.sector === sector);
        const primary = sp?.roles.find((r) => r.primary);
        if (sp === undefined || primary === undefined) continue;
        predicted += 1;
        per[primary.axis].predicted += 1;
        const correct = label === primary.axis;
        if (correct) per[primary.axis].tp += 1;
        const conf = sp.axes[primary.axis].confidence;
        const bin = bins[Math.min(9, Math.floor(conf * 10))];
        if (bin !== undefined) {
          bin.n += 1;
          bin.conf += conf;
          bin.correct += correct ? 1 : 0;
        }
      }
    }
  }
  const per_role = {} as CalibrationReport['per_role'];
  for (const a of AXES) {
    per_role[ROLE_LABEL[a]] = {
      precision: ratio(per[a].tp, per[a].predicted),
      recall: ratio(per[a].tp, per[a].labelled),
      predicted: per[a].predicted,
      labelled: per[a].labelled,
    };
  }
  let ece = 0;
  for (const b of bins) if (b.n > 0) ece += (b.n / Math.max(1, predicted)) * Math.abs(b.correct / b.n - b.conf / b.n);
  return {
    assessed,
    predicted_with_role: predicted,
    per_role,
    ece: predicted === 0 ? null : ece,
    bins: bins.map((b) => ({ lo: b.lo, hi: b.hi, n: b.n, mean_confidence: ratio(b.conf, b.n), accuracy: ratio(b.correct, b.n) })),
  };
}

export interface PrecisionAtK {
  k: number;
  sparks_with_trios: number;
  sparks_without_trios: number;
  precision: number | null;
}

/** Share of proposed members (top-k trios) whose simulated verifier label equals the proposed role. */
export function precisionAtK(run: SimulationRun, k: number): PrecisionAtK {
  let hits = 0;
  let total = 0;
  let withT = 0;
  let without = 0;
  for (const inst of run.instances) {
    const byId = new Map(inst.members.map((m) => [m.member.person_id, m.member]));
    for (const s of inst.sparks) {
      if (s.result.trios.length === 0) {
        without += 1;
        continue;
      }
      withT += 1;
      for (const t of s.result.trios.slice(0, k)) {
        for (const m of t.members) {
          total += 1;
          if (byId.get(m.person_id)?.verifier_label[s.seed.sector] === m.axis) hits += 1;
        }
      }
    }
  }
  return { k, sparks_with_trios: withT, sparks_without_trios: without, precision: ratio(hits, total) };
}

export interface CompletionLift {
  sparks_compared: number;
  mean_p_proposed: number | null;
  mean_p_random: number | null;
  /** mean_p_proposed / mean_p_random. */
  lift: number | null;
  simulated_completed: number;
  simulated_run: number;
}

export function completionLift(run: SimulationRun): CompletionLift {
  let pt = 0;
  let pr = 0;
  let n = 0;
  let done = 0;
  let ran = 0;
  for (const inst of run.instances) {
    for (const s of inst.sparks) {
      if (s.completed !== null) {
        ran += 1;
        if (s.completed) done += 1;
      }
      if (s.p_top === null || s.p_random === null) continue;
      pt += s.p_top;
      pr += s.p_random;
      n += 1;
    }
  }
  return {
    sparks_compared: n,
    mean_p_proposed: ratio(pt, n),
    mean_p_random: ratio(pr, n),
    lift: pr === 0 ? null : pt / pr,
    simulated_completed: done,
    simulated_run: ran,
  };
}

export interface MapStability {
  cells: number;
  /** Mean |TR(now) - TR(now + 30d)| with no new evidence: decay-only drift. */
  mean_abs_tr_change_30d: number;
  max_abs_tr_change_30d: number;
  /** Share of cells whose public TR band changed over the 30 days. */
  band_change_rate_30d: number;
}

export function mapStability(run: SimulationRun, band: (tr: number) => string): MapStability {
  let n = 0;
  let sum = 0;
  let max = 0;
  let bandChanges = 0;
  for (const inst of run.instances) {
    inst.cells.forEach((c, i) => {
      const later = inst.cells_later[i];
      if (later === undefined) return;
      const d = Math.abs(c.tr - later.tr);
      n += 1;
      sum += d;
      max = Math.max(max, d);
      if (band(c.tr) !== band(later.tr)) bandChanges += 1;
    });
  }
  return { cells: n, mean_abs_tr_change_30d: n === 0 ? 0 : sum / n, max_abs_tr_change_30d: max, band_change_rate_30d: n === 0 ? 0 : bandChanges / n };
}
