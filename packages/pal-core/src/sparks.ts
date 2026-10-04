// Spark gates (spec 5.7). A Spark is an existing sprint cycle plus PAL fields; money moves only
// through the existing sprint/fund-pool/payout code. These pure checks decide whether a
// transition is allowed; edge functions call them before touching any existing pipeline.

import { AXES } from './config.ts';
import type { Axis, ResolvedConfig } from './config.ts';
import { validateValueSplit } from './config.ts';

export const SPARK_STATUSES = ['draft', 'approved', 'inviting', 'open', 'active', 'settling', 'closed', 'cancelled'] as const;
export type SparkStatus = (typeof SPARK_STATUSES)[number];

const TRANSITIONS: Readonly<Record<SparkStatus, readonly SparkStatus[]>> = {
  draft: ['approved', 'cancelled'],
  approved: ['inviting', 'cancelled'],
  inviting: ['open', 'cancelled'],
  open: ['active', 'cancelled'],
  active: ['settling', 'cancelled'],
  settling: ['closed'],
  closed: [],
  cancelled: [],
};

export function canTransition(from: SparkStatus, to: SparkStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface SparkRecord {
  id: string;
  place_id: string;
  sector: string;
  duration_days: number;
  status: SparkStatus;
  funded: boolean;
  /** Requested pool amount in the instance currency; null for unfunded Sparks. */
  requested_amount: number | null;
  value_split: Readonly<Record<string, number>> | null;
  split_locked_at: string | null;
  steward_approved_at: string | null;
  /** Roles whose invited member has accepted. */
  accepted_roles: readonly Axis[];
}

export type SparkGateError =
  | 'invalid_duration'
  | 'unknown_sector'
  | 'funding_cap_unset'
  | 'amount_required'
  | 'over_funding_cap'
  | 'value_split_missing'
  | 'value_split_invalid'
  | 'no_active_verifier'
  | 'not_steward_approved'
  | 'split_not_locked'
  | 'trio_incomplete'
  | 'invalid_transition';

export type GateResult = { ok: true } | { ok: false; errors: SparkGateError[] };

function result(errors: SparkGateError[]): GateResult {
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/** Effective split: the Spark's own, else the instance default. */
export function effectiveSplit(spark: Pick<SparkRecord, 'value_split'>, cfg: ResolvedConfig): Record<string, number> | null {
  return spark.value_split !== null ? { ...spark.value_split } : cfg.sparks.value_split_defaults;
}

/** POST /sparks (draft). */
export function checkCreate(
  spark: Pick<SparkRecord, 'sector' | 'duration_days' | 'funded' | 'requested_amount' | 'value_split'>,
  cfg: ResolvedConfig,
): GateResult {
  const errors: SparkGateError[] = [];
  if (!cfg.sparks.durations_days.includes(spark.duration_days)) errors.push('invalid_duration');
  if (!cfg.sectors.includes(spark.sector)) errors.push('unknown_sector');
  if (spark.value_split !== null && validateValueSplit({ ...spark.value_split }) !== null) errors.push('value_split_invalid');
  if (spark.funded) {
    const cap = cfg.sparks.funding_cap;
    if (cap === null) errors.push('funding_cap_unset');
    if (spark.requested_amount === null || !(spark.requested_amount > 0)) errors.push('amount_required');
    else if (cap !== null && spark.requested_amount > cap) errors.push('over_funding_cap');
    if (effectiveSplit(spark, cfg) === null) errors.push('value_split_missing');
  }
  return result(errors);
}

/** Invites go out only after steward approval. */
export function checkInvite(spark: Pick<SparkRecord, 'steward_approved_at' | 'status'>): GateResult {
  const errors: SparkGateError[] = [];
  if (spark.steward_approved_at === null) errors.push('not_steward_approved');
  if (spark.status !== 'approved' && spark.status !== 'inviting') errors.push('invalid_transition');
  return result(errors);
}

/** inviting -> open. */
export function checkOpen(spark: SparkRecord, activeVerifiersInPlace: number, cfg: ResolvedConfig): GateResult {
  const errors: SparkGateError[] = [];
  if (!canTransition(spark.status, 'open')) errors.push('invalid_transition');
  if (activeVerifiersInPlace < cfg.sparks.min_active_verifiers) errors.push('no_active_verifier');
  if (spark.steward_approved_at === null) errors.push('not_steward_approved');
  if (!AXES.every((a) => spark.accepted_roles.includes(a))) errors.push('trio_incomplete');
  if (spark.funded) {
    // Re-check funding gates at open time: config may have changed since the draft.
    const create = checkCreate(spark, cfg);
    if (!create.ok) errors.push(...create.errors.filter((e) => e !== 'invalid_duration' && e !== 'unknown_sector'));
    if (spark.split_locked_at === null) errors.push('split_not_locked');
  }
  return result([...new Set(errors)]);
}

/** Before any funds move (settle triggers the existing milestone-gated release). */
export function checkFundsMove(spark: SparkRecord): GateResult {
  const errors: SparkGateError[] = [];
  if (spark.status !== 'active' && spark.status !== 'settling') errors.push('invalid_transition');
  if (spark.funded && spark.split_locked_at === null) errors.push('split_not_locked');
  return result(errors);
}

export interface VerifierAssignment {
  verifier_id: string;
  place_id: string;
  active_from: string;
  active_to: string | null;
}

/**
 * Active verifiers covering a place: assignments to the place itself or any ancestor
 * (e.g. a county assignment covers its sub-counties). Distinct verifiers.
 * STUB(verifier_assignments schema not visible): the adapter maps the real table to this shape.
 */
export function countActiveVerifiers(
  assignments: readonly VerifierAssignment[],
  placeAndAncestorIds: readonly string[],
  now: string,
): number {
  const t = Date.parse(now);
  const ids = new Set<string>();
  for (const a of assignments) {
    if (!placeAndAncestorIds.includes(a.place_id)) continue;
    if (Date.parse(a.active_from) > t) continue;
    if (a.active_to !== null && Date.parse(a.active_to) <= t) continue;
    ids.add(a.verifier_id);
  }
  return ids.size;
}
