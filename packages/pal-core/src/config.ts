// PAL Engine configuration: types, defaults, validation and per-instance resolution.
// Pure: no I/O. Callers load YAML/JSON and hand the parsed object to validateConfig().

export const AXES = ['capital', 'vision', 'execution'] as const;
export type Axis = (typeof AXES)[number];

export const VERIFICATION_LEVELS = ['unverified', 'verified', 'corroborated'] as const;
export type VerificationLevel = (typeof VERIFICATION_LEVELS)[number];

export type RoleLabel = 'Partner' | 'Ambassador' | 'Leader';
export const ROLE_LABEL: Readonly<Record<Axis, RoleLabel>> = {
  capital: 'Partner',
  vision: 'Ambassador',
  execution: 'Leader',
};
export type RoleKey = 'partner' | 'ambassador' | 'leader';
export const ROLE_KEY: Readonly<Record<Axis, RoleKey>> = {
  capital: 'partner',
  vision: 'ambassador',
  execution: 'leader',
};

export interface ScoringConfig {
  half_life_months: number;
  points_per_unit: number;
  claimed_cap_per_axis: number;
  claimed_points_per_item: number;
  claimed_match_weight: number;
  verification_multiplier: Record<VerificationLevel, number>;
  evidence_weights: Record<Axis, Record<string, number>>;
}

export interface RoleTargets {
  partner: number;
  ambassador: number;
  leader: number;
}

export interface MatchingConfig {
  weights: { fit: number; trust: number; availability: number; diversity: number };
  max_trios: number;
  min_distinct_clusters: number;
  candidates_per_role: number;
}

export interface SparksConfig {
  durations_days: number[];
  funding_cap: number | null;
  value_split_defaults: Record<string, number> | null;
  min_active_verifiers: number;
}

export interface InstanceConfig {
  id: string;
  country: string;
  place_type: string;
  currency: string;
  languages: string[];
  regulator: string;
  overrides?: Partial<Omit<PalConfig, 'instances' | 'model_version'>>;
}

export interface PalConfig {
  model_version: string;
  scoring: ScoringConfig;
  roles: { role_threshold: number; multi_role_ratio: number };
  states: {
    rising_delta_90d: number;
    established_min: number;
    dormant_below: number;
    dormant_if_peak_at_least: number;
  };
  confidence: { min_for_map_count: number };
  privacy: { k_min: number; purge_days: number };
  readiness_targets: Record<string, RoleTargets>;
  matching: MatchingConfig;
  extraction: {
    validated_languages: string[];
    unvalidated_language_weight: number;
    max_value_length: number;
  };
  sparks: SparksConfig;
  fairness: { max_median_gap: number };
  sectors: string[];
  levers: string[];
  instances: InstanceConfig[];
}

/** A config resolved for one instance: overrides applied, `instance` attached. */
export interface ResolvedConfig extends Omit<PalConfig, 'instances'> {
  instance: Omit<InstanceConfig, 'overrides'>;
}

/**
 * Default settings (mirrors config/pal.config.yaml without `instances`). Instances are data and
 * exist only in configuration, never in code.
 */
export const DEFAULT_SETTINGS: Omit<PalConfig, 'instances'> = {
  model_version: 'pal-core@0.1.0',
  scoring: {
    half_life_months: 18,
    points_per_unit: 10,
    claimed_cap_per_axis: 25,
    claimed_points_per_item: 5,
    claimed_match_weight: 0.4,
    verification_multiplier: { unverified: 0, verified: 1, corroborated: 1.25 },
    evidence_weights: {
      capital: {
        pool_contribution: 1,
        funded_status: 1,
        sprint_commitment_paid: 0.8,
        facility_listing_verified: 0.6,
      },
      vision: { referral_active: 0.7, event_convened_verified: 0.8, content_engaged_by_verified: 0.4 },
      execution: {
        sprint_closed_verified: 1,
        eco_event_corroborated: 0.6,
        training_delivered_verified: 0.8,
        team_led: 0.7,
      },
    },
  },
  roles: { role_threshold: 30, multi_role_ratio: 0.8 },
  states: { rising_delta_90d: 5, established_min: 20, dormant_below: 10, dormant_if_peak_at_least: 20 },
  confidence: { min_for_map_count: 0.4 },
  privacy: { k_min: 10, purge_days: 30 },
  readiness_targets: {
    territorial_urban: { partner: 5, ambassador: 10, leader: 8 },
    territorial_rural: { partner: 3, ambassador: 6, leader: 5 },
  },
  matching: {
    weights: { fit: 0.35, trust: 0.25, availability: 0.2, diversity: 0.2 },
    max_trios: 3,
    min_distinct_clusters: 2,
    candidates_per_role: 15,
  },
  extraction: { validated_languages: ['en'], unvalidated_language_weight: 0.5, max_value_length: 160 },
  sparks: { durations_days: [7, 14, 30], funding_cap: null, value_split_defaults: null, min_active_verifiers: 1 },
  fairness: { max_median_gap: 15 },
  sectors: ['agriculture', 'health', 'education', 'finance', 'energy', 'waste_climate'],
  levers: ['energy', 'education', 'media', 'data', 'design', 'digital'],
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ConfigIssue {
  path: string;
  message: string;
}

export type ConfigResult =
  | { ok: true; config: PalConfig }
  | { ok: false; issues: ConfigIssue[] };

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

class Checker {
  readonly issues: ConfigIssue[] = [];

  fail(path: string, message: string): void {
    this.issues.push({ path, message });
  }

  obj(v: unknown, path: string): Obj {
    if (!isObj(v)) {
      this.fail(path, 'must be an object');
      return {};
    }
    return v;
  }

  num(v: unknown, path: string, opts: { min?: number; max?: number; int?: boolean; gt?: number } = {}): number {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      this.fail(path, 'must be a finite number');
      return 0;
    }
    if (opts.int === true && !Number.isInteger(v)) this.fail(path, 'must be an integer');
    if (opts.min !== undefined && v < opts.min) this.fail(path, `must be >= ${opts.min}`);
    if (opts.max !== undefined && v > opts.max) this.fail(path, `must be <= ${opts.max}`);
    if (opts.gt !== undefined && v <= opts.gt) this.fail(path, `must be > ${opts.gt}`);
    return v;
  }

  str(v: unknown, path: string, pattern?: RegExp): string {
    if (typeof v !== 'string' || v.length === 0) {
      this.fail(path, 'must be a non-empty string');
      return '';
    }
    if (pattern !== undefined && !pattern.test(v)) this.fail(path, `must match ${pattern.source}`);
    return v;
  }

  strList(v: unknown, path: string, pattern?: RegExp): string[] {
    if (!Array.isArray(v)) {
      this.fail(path, 'must be an array of strings');
      return [];
    }
    const out = v.map((item, i) => this.str(item, `${path}[${i}]`, pattern));
    if (new Set(out).size !== out.length) this.fail(path, 'must not contain duplicates');
    return out;
  }

  noExtraKeys(o: Obj, path: string, allowed: readonly string[]): void {
    for (const k of Object.keys(o)) {
      if (!allowed.includes(k)) this.fail(`${path}.${k}`, 'unknown key');
    }
  }
}

const SLUG = /^[a-z][a-z0-9_]*$/;

function checkScoring(c: Checker, raw: unknown, path: string): ScoringConfig {
  const o = c.obj(raw, path);
  c.noExtraKeys(o, path, [
    'half_life_months',
    'points_per_unit',
    'claimed_cap_per_axis',
    'claimed_points_per_item',
    'claimed_match_weight',
    'verification_multiplier',
    'evidence_weights',
  ]);
  const vm = c.obj(o['verification_multiplier'], `${path}.verification_multiplier`);
  c.noExtraKeys(vm, `${path}.verification_multiplier`, VERIFICATION_LEVELS);
  const verification_multiplier = {
    unverified: c.num(vm['unverified'], `${path}.verification_multiplier.unverified`, { min: 0, max: 0 }),
    verified: c.num(vm['verified'], `${path}.verification_multiplier.verified`, { min: 0 }),
    corroborated: c.num(vm['corroborated'], `${path}.verification_multiplier.corroborated`, { min: 0 }),
  };
  const ew = c.obj(o['evidence_weights'], `${path}.evidence_weights`);
  c.noExtraKeys(ew, `${path}.evidence_weights`, AXES);
  const evidence_weights = {} as Record<Axis, Record<string, number>>;
  for (const axis of AXES) {
    const p = `${path}.evidence_weights.${axis}`;
    const m = c.obj(ew[axis], p);
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(m)) {
      if (!SLUG.test(k)) c.fail(`${p}.${k}`, 'evidence type must be a slug');
      out[k] = c.num(v, `${p}.${k}`, { min: 0, max: 1 });
    }
    evidence_weights[axis] = out;
  }
  return {
    half_life_months: c.num(o['half_life_months'], `${path}.half_life_months`, { gt: 0 }),
    points_per_unit: c.num(o['points_per_unit'], `${path}.points_per_unit`, { gt: 0 }),
    claimed_cap_per_axis: c.num(o['claimed_cap_per_axis'], `${path}.claimed_cap_per_axis`, { min: 0, max: 100 }),
    claimed_points_per_item: c.num(o['claimed_points_per_item'], `${path}.claimed_points_per_item`, { min: 0 }),
    claimed_match_weight: c.num(o['claimed_match_weight'], `${path}.claimed_match_weight`, { min: 0, max: 1 }),
    verification_multiplier,
    evidence_weights,
  };
}

function checkTargets(c: Checker, raw: unknown, path: string): Record<string, RoleTargets> {
  const o = c.obj(raw, path);
  const out: Record<string, RoleTargets> = {};
  for (const [profile, v] of Object.entries(o)) {
    const p = `${path}.${profile}`;
    if (!SLUG.test(profile)) c.fail(p, 'profile name must be a slug');
    const t = c.obj(v, p);
    c.noExtraKeys(t, p, ['partner', 'ambassador', 'leader']);
    out[profile] = {
      partner: c.num(t['partner'], `${p}.partner`, { gt: 0 }),
      ambassador: c.num(t['ambassador'], `${p}.ambassador`, { gt: 0 }),
      leader: c.num(t['leader'], `${p}.leader`, { gt: 0 }),
    };
  }
  if (Object.keys(out).length === 0) c.fail(path, 'must define at least one target profile');
  return out;
}

function checkMatching(c: Checker, raw: unknown, path: string): MatchingConfig {
  const o = c.obj(raw, path);
  c.noExtraKeys(o, path, ['weights', 'max_trios', 'min_distinct_clusters', 'candidates_per_role']);
  const w = c.obj(o['weights'], `${path}.weights`);
  c.noExtraKeys(w, `${path}.weights`, ['fit', 'trust', 'availability', 'diversity']);
  const weights = {
    fit: c.num(w['fit'], `${path}.weights.fit`, { min: 0, max: 1 }),
    trust: c.num(w['trust'], `${path}.weights.trust`, { min: 0, max: 1 }),
    availability: c.num(w['availability'], `${path}.weights.availability`, { min: 0, max: 1 }),
    diversity: c.num(w['diversity'], `${path}.weights.diversity`, { min: 0, max: 1 }),
  };
  const sum = weights.fit + weights.trust + weights.availability + weights.diversity;
  if (Math.abs(sum - 1) > 1e-9) c.fail(`${path}.weights`, 'must sum to 1');
  return {
    weights,
    max_trios: c.num(o['max_trios'], `${path}.max_trios`, { int: true, min: 1, max: 20 }),
    min_distinct_clusters: c.num(o['min_distinct_clusters'], `${path}.min_distinct_clusters`, {
      int: true,
      min: 1,
      max: 3,
    }),
    candidates_per_role: c.num(o['candidates_per_role'], `${path}.candidates_per_role`, {
      int: true,
      min: 1,
      max: 100,
    }),
  };
}

function checkSparks(c: Checker, raw: unknown, path: string): SparksConfig {
  const o = c.obj(raw, path);
  c.noExtraKeys(o, path, ['durations_days', 'funding_cap', 'value_split_defaults', 'min_active_verifiers']);
  const durRaw = o['durations_days'];
  const durations_days: number[] = [];
  if (!Array.isArray(durRaw) || durRaw.length === 0) c.fail(`${path}.durations_days`, 'must be a non-empty array');
  else durRaw.forEach((d, i) => durations_days.push(c.num(d, `${path}.durations_days[${i}]`, { int: true, min: 1 })));
  const capRaw = o['funding_cap'];
  const funding_cap = capRaw === null || capRaw === undefined ? null : c.num(capRaw, `${path}.funding_cap`, { gt: 0 });
  const splitRaw = o['value_split_defaults'];
  let value_split_defaults: Record<string, number> | null = null;
  if (splitRaw !== null && splitRaw !== undefined) {
    const s = c.obj(splitRaw, `${path}.value_split_defaults`);
    value_split_defaults = {};
    for (const [k, v] of Object.entries(s)) {
      value_split_defaults[k] = c.num(v, `${path}.value_split_defaults.${k}`, { min: 0, max: 1 });
    }
    const err = validateValueSplit(value_split_defaults);
    if (err !== null) c.fail(`${path}.value_split_defaults`, err);
  }
  return {
    durations_days,
    funding_cap,
    value_split_defaults,
    min_active_verifiers: c.num(o['min_active_verifiers'], `${path}.min_active_verifiers`, { int: true, min: 1 }),
  };
}

/** Returns an error message, or null when the split is valid (shares in [0,1] summing to 1). */
export function validateValueSplit(split: Record<string, number>): string | null {
  const entries = Object.entries(split);
  if (entries.length === 0) return 'value split must have at least one share';
  let sum = 0;
  for (const [k, v] of entries) {
    if (!SLUG.test(k)) return `value split key "${k}" must be a slug`;
    if (!Number.isFinite(v) || v < 0 || v > 1) return `value split share "${k}" must be in [0,1]`;
    sum += v;
  }
  if (Math.abs(sum - 1) > 1e-9) return 'value split shares must sum to 1';
  return null;
}

const SECTION_KEYS = [
  'scoring',
  'roles',
  'states',
  'confidence',
  'privacy',
  'readiness_targets',
  'matching',
  'extraction',
  'sparks',
  'fairness',
  'sectors',
  'levers',
] as const;
type SectionKey = (typeof SECTION_KEYS)[number];

function checkSections(c: Checker, o: Obj, path: string): Omit<PalConfig, 'instances' | 'model_version'> {
  const roles = c.obj(o['roles'], `${path}.roles`);
  c.noExtraKeys(roles, `${path}.roles`, ['role_threshold', 'multi_role_ratio']);
  const states = c.obj(o['states'], `${path}.states`);
  c.noExtraKeys(states, `${path}.states`, [
    'rising_delta_90d',
    'established_min',
    'dormant_below',
    'dormant_if_peak_at_least',
  ]);
  const conf = c.obj(o['confidence'], `${path}.confidence`);
  c.noExtraKeys(conf, `${path}.confidence`, ['min_for_map_count']);
  const priv = c.obj(o['privacy'], `${path}.privacy`);
  c.noExtraKeys(priv, `${path}.privacy`, ['k_min', 'purge_days']);
  const ext = c.obj(o['extraction'], `${path}.extraction`);
  c.noExtraKeys(ext, `${path}.extraction`, ['validated_languages', 'unvalidated_language_weight', 'max_value_length']);
  const fair = c.obj(o['fairness'], `${path}.fairness`);
  c.noExtraKeys(fair, `${path}.fairness`, ['max_median_gap']);

  const k_min = c.num(priv['k_min'], `${path}.privacy.k_min`, { int: true, min: 2 });
  return {
    scoring: checkScoring(c, o['scoring'], `${path}.scoring`),
    roles: {
      role_threshold: c.num(roles['role_threshold'], `${path}.roles.role_threshold`, { gt: 0, max: 100 }),
      multi_role_ratio: c.num(roles['multi_role_ratio'], `${path}.roles.multi_role_ratio`, { gt: 0, max: 1 }),
    },
    states: {
      rising_delta_90d: c.num(states['rising_delta_90d'], `${path}.states.rising_delta_90d`, { gt: 0 }),
      established_min: c.num(states['established_min'], `${path}.states.established_min`, { gt: 0, max: 100 }),
      dormant_below: c.num(states['dormant_below'], `${path}.states.dormant_below`, { gt: 0, max: 100 }),
      dormant_if_peak_at_least: c.num(states['dormant_if_peak_at_least'], `${path}.states.dormant_if_peak_at_least`, {
        gt: 0,
        max: 100,
      }),
    },
    confidence: {
      min_for_map_count: c.num(conf['min_for_map_count'], `${path}.confidence.min_for_map_count`, { min: 0, max: 1 }),
    },
    privacy: {
      k_min,
      purge_days: c.num(priv['purge_days'], `${path}.privacy.purge_days`, { int: true, min: 1, max: 30 }),
    },
    readiness_targets: checkTargets(c, o['readiness_targets'], `${path}.readiness_targets`),
    matching: checkMatching(c, o['matching'], `${path}.matching`),
    extraction: {
      validated_languages: c.strList(ext['validated_languages'], `${path}.extraction.validated_languages`, SLUG),
      unvalidated_language_weight: c.num(
        ext['unvalidated_language_weight'],
        `${path}.extraction.unvalidated_language_weight`,
        { min: 0, max: 1 },
      ),
      max_value_length: c.num(ext['max_value_length'], `${path}.extraction.max_value_length`, {
        int: true,
        min: 1,
        max: 160,
      }),
    },
    sparks: checkSparks(c, o['sparks'], `${path}.sparks`),
    fairness: { max_median_gap: c.num(fair['max_median_gap'], `${path}.fairness.max_median_gap`, { gt: 0 }) },
    sectors: c.strList(o['sectors'], `${path}.sectors`, SLUG),
    levers: c.strList(o['levers'], `${path}.levers`, SLUG),
  };
}

/** Deep-merge plain objects; arrays and scalars in `over` replace those in `base`. */
export function deepMerge<T>(base: T, over: unknown): T {
  if (!isObj(base) || !isObj(over)) return (over === undefined ? base : over) as T;
  const out: Obj = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

/**
 * Strictly validate a parsed config object. Unknown keys are rejected (typos must not silently
 * fall back to defaults). Each instance's overrides are validated after merging onto the base.
 */
export function validateConfig(raw: unknown): ConfigResult {
  const c = new Checker();
  const o = c.obj(raw, '$');
  c.noExtraKeys(o, '$', ['model_version', ...SECTION_KEYS, 'instances']);
  const model_version = c.str(o['model_version'], '$.model_version');
  const sections = checkSections(c, o, '$');

  const instances: InstanceConfig[] = [];
  const instRaw = o['instances'];
  if (!Array.isArray(instRaw) || instRaw.length === 0) {
    c.fail('$.instances', 'must be a non-empty array');
  } else {
    instRaw.forEach((iv, i) => {
      const p = `$.instances[${i}]`;
      const io = c.obj(iv, p);
      c.noExtraKeys(io, p, ['id', 'country', 'place_type', 'currency', 'languages', 'regulator', 'overrides']);
      const inst: InstanceConfig = {
        id: c.str(io['id'], `${p}.id`, SLUG),
        country: c.str(io['country'], `${p}.country`, /^[A-Z]{2}$/),
        place_type: c.str(io['place_type'], `${p}.place_type`, SLUG),
        currency: c.str(io['currency'], `${p}.currency`, /^[A-Z]{3}$/),
        languages: c.strList(io['languages'], `${p}.languages`, SLUG),
        regulator: c.str(io['regulator'], `${p}.regulator`),
      };
      if (io['overrides'] !== undefined) {
        const ov = c.obj(io['overrides'], `${p}.overrides`);
        c.noExtraKeys(ov, `${p}.overrides`, SECTION_KEYS);
        // Validate the merged result so an override can never produce an invalid effective config.
        checkSections(c, deepMerge(sections as unknown as Obj, ov), `${p}.overrides(merged)`);
        inst.overrides = ov as InstanceConfig['overrides'];
      }
      instances.push(inst);
    });
    const ids = instances.map((x) => x.id);
    if (new Set(ids).size !== ids.length) c.fail('$.instances', 'instance ids must be unique');
  }

  if (c.issues.length > 0) return { ok: false, issues: c.issues };
  return { ok: true, config: { model_version, ...sections, instances } };
}

export class UnknownInstanceError extends Error {
  readonly code = 'unknown_instance';
  constructor(id: string) {
    super(`unknown instance: ${id}`);
  }
}

/** Effective config for one instance (base config with that instance's overrides merged in). */
export function resolveInstanceConfig(config: PalConfig, instanceId: string): ResolvedConfig {
  const inst = config.instances.find((i) => i.id === instanceId);
  if (inst === undefined) throw new UnknownInstanceError(instanceId);
  const { instances: _all, ...base } = config;
  const { overrides, ...instance } = inst;
  const merged = deepMerge(base, overrides ?? {});
  return { ...merged, instance };
}

export function isSectionKey(k: string): k is SectionKey {
  return (SECTION_KEYS as readonly string[]).includes(k);
}
