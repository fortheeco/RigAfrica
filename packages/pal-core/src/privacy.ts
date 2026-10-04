// Consent, purge, non-member protection, k-anonymity and access logging (spec 2.3, 2.4, 2.7, 2.8, 2.12, 5.5).
// Pure: randomness, clocks, hashing secrets and storage are supplied by callers.

import { MS_PER_DAY } from './scoring.ts';

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

/** How a source's data reaches PAL. Scraping and arbitrary-username lookups do not exist here. */
export type ConsentMethod = 'oauth' | 'export_upload' | 'self_declared' | 'contacts_upload';

export interface Consent {
  person_id: string;
  /** e.g. "linkedin", "x", "eco_self_declared", "contacts". */
  source: string;
  method: ConsentMethod;
  scopes: readonly string[];
  granted_at: string;
  revoked_at: string | null;
  /** Ownership proof for social handles (OAuth completion or bio-code). Null until proven. */
  handle_verified_at: string | null;
}

export type ConsentDenial = 'no_consent' | 'consent_revoked' | 'scope_missing' | 'handle_unverified';
export type ConsentCheck = { ok: true; consent: Consent } | { ok: false; code: ConsentDenial };

/** Social sources must prove handle ownership before anything is ingested. */
export function requiresHandleProof(method: ConsentMethod): boolean {
  return method === 'oauth' || method === 'export_upload';
}

/**
 * Consent gate for ingestion. Uses the latest consent row for (person, source); a revoked row
 * blocks even if an older row was active.
 */
export function checkConsent(
  consents: readonly Consent[],
  person_id: string,
  source: string,
  requiredScope: string,
  now: string,
): ConsentCheck {
  const nowMs = Date.parse(now);
  const rows = consents
    .filter((c) => c.person_id === person_id && c.source === source && Date.parse(c.granted_at) <= nowMs)
    .sort((a, b) => Date.parse(b.granted_at) - Date.parse(a.granted_at));
  const latest = rows[0];
  if (latest === undefined) return { ok: false, code: 'no_consent' };
  if (latest.revoked_at !== null && Date.parse(latest.revoked_at) <= nowMs) return { ok: false, code: 'consent_revoked' };
  if (!latest.scopes.includes(requiredScope)) return { ok: false, code: 'scope_missing' };
  if (requiresHandleProof(latest.method) && latest.handle_verified_at === null) {
    return { ok: false, code: 'handle_unverified' };
  }
  return { ok: true, consent: latest };
}

export function isActiveConsent(c: Consent, now: string): boolean {
  return c.revoked_at === null || Date.parse(c.revoked_at) > Date.parse(now);
}

// ---------------------------------------------------------------------------
// Handle ownership: one-time code placed in the public bio
// ---------------------------------------------------------------------------

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

/** Build a bio code from caller-supplied random bytes (crypto.getRandomValues in the edge function). */
export function bioCodeFromBytes(bytes: Uint8Array, length = 8): string {
  if (bytes.length < length) throw new Error('not enough random bytes');
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[(bytes[i] as number) % CODE_ALPHABET.length];
  return `ECO-${out}`;
}

export interface BioChallenge {
  code: string;
  issued_at: string;
  ttl_hours: number;
}

export type BioCheck = 'verified' | 'expired' | 'code_not_found';

/** The bio text is fetched by the connector from the official API for the authenticated handle only. */
export function verifyBioCode(bioText: string, challenge: BioChallenge, now: string): BioCheck {
  const expires = Date.parse(challenge.issued_at) + challenge.ttl_hours * 3_600_000;
  if (Date.parse(now) > expires) return 'expired';
  return bioText.toUpperCase().includes(challenge.code.toUpperCase()) ? 'verified' : 'code_not_found';
}

// ---------------------------------------------------------------------------
// Purge on revoke
// ---------------------------------------------------------------------------

export interface PurgeableRow {
  id: string;
  person_id: string;
  source: string;
}

export interface PurgeTarget {
  person_id: string;
  source: string;
  revoked_at: string;
  due_at: string;
}

export interface PurgePlan {
  /** Every derived row of a revoked (person, source). Deleted on the first run after revocation. */
  delete_ids: string[];
  people_to_recompute: string[];
  targets: PurgeTarget[];
  /** Targets past their deadline that still had rows: an SLA breach to alert on. */
  overdue: PurgeTarget[];
}

export function purgeDueAt(revokedAt: string, purgeDays: number): string {
  return new Date(Date.parse(revokedAt) + purgeDays * MS_PER_DAY).toISOString();
}

export function planPurge(
  consents: readonly Consent[],
  rows: readonly PurgeableRow[],
  now: string,
  purgeDays: number,
): PurgePlan {
  const nowMs = Date.parse(now);
  // A (person, source) is revoked when its latest consent row is revoked.
  const latest = new Map<string, Consent>();
  for (const c of consents) {
    const k = `${c.person_id}\u0000${c.source}`;
    const prev = latest.get(k);
    if (prev === undefined || Date.parse(c.granted_at) > Date.parse(prev.granted_at)) latest.set(k, c);
  }
  const targets = new Map<string, PurgeTarget>();
  for (const [k, c] of latest) {
    if (c.revoked_at !== null && Date.parse(c.revoked_at) <= nowMs) {
      targets.set(k, {
        person_id: c.person_id,
        source: c.source,
        revoked_at: c.revoked_at,
        due_at: purgeDueAt(c.revoked_at, purgeDays),
      });
    }
  }
  const delete_ids: string[] = [];
  const people = new Set<string>();
  const hit = new Set<string>();
  for (const r of rows) {
    const k = `${r.person_id}\u0000${r.source}`;
    if (targets.has(k)) {
      delete_ids.push(r.id);
      people.add(r.person_id);
      hit.add(k);
    }
  }
  const overdue = [...hit].map((k) => targets.get(k) as PurgeTarget).filter((t) => Date.parse(t.due_at) < nowMs);
  return { delete_ids, people_to_recompute: [...people].sort(), targets: [...targets.values()], overdue };
}

// ---------------------------------------------------------------------------
// Non-members: contact hashes are matched against existing ECO ID aliases only
// ---------------------------------------------------------------------------

export interface ContactMatchResult {
  /** ECO person ids of existing members. Nothing else from the upload survives this function. */
  matched_person_ids: string[];
  /** Count only: unmatched hashes are discarded and never persisted. */
  dropped: number;
}

/**
 * `hashes` are HMAC(pepper, alias) computed with the same normalisation and pepper as
 * eco-id-resolve; `aliasIndex` maps alias hash -> ECO person id for existing members.
 */
export function matchContactHashes(
  hashes: readonly string[],
  aliasIndex: ReadonlyMap<string, string>,
  ownerPersonId: string,
): ContactMatchResult {
  const matched = new Set<string>();
  let dropped = 0;
  for (const h of new Set(hashes)) {
    const pid = aliasIndex.get(h);
    if (pid === undefined) dropped += 1;
    else if (pid !== ownerPersonId) matched.add(pid);
  }
  return { matched_person_ids: [...matched].sort(), dropped };
}

// STUB(eco-id-resolve not visible): normalisation must byte-match eco-id-resolve before contact
// matching is enabled, or every hash will miss. Replace with an import of its shared normaliser.
export function normaliseEmailAlias(raw: string): string {
  return `email:${raw.trim().toLowerCase()}`;
}

// STUB(eco-id-resolve not visible): see normaliseEmailAlias. E.164 digits with the instance's
// country calling code supplied by the caller from instance config (never hardcoded).
export function normalisePhoneAlias(raw: string, countryCallingCode: string): string | null {
  let d = raw.replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = countryCallingCode + d.slice(1);
  else if (!d.startsWith(countryCallingCode)) d = countryCallingCode + d;
  return /^\d{8,15}$/.test(d) ? `phone:+${d}` : null;
}

// ---------------------------------------------------------------------------
// k-anonymity
// ---------------------------------------------------------------------------

export type BandedCount = { kind: 'count'; value: number } | { kind: 'band'; band: string; lt: number };

/** Counts below k_min (including 0) are replaced by a band; no number is revealed. */
export function bandCount(n: number, kMin: number): BandedCount {
  return n >= kMin ? { kind: 'count', value: n } : { kind: 'band', band: `fewer than ${kMin}`, lt: kMin };
}

export function isRevealed(b: BandedCount): b is { kind: 'count'; value: number } {
  return b.kind === 'count';
}

// ---------------------------------------------------------------------------
// Access logging
// ---------------------------------------------------------------------------

export type ViewerRole = 'owner' | 'steward' | 'admin' | 'service' | 'app';

export interface AccessLogEntry {
  viewer_id: string;
  viewer_role: ViewerRole;
  subject_person_id: string;
  resource: string;
  purpose: string;
  at: string;
}

/** Every profile view by anyone other than the owner is logged. */
export function accessLogEntry(
  viewer: { id: string; role: ViewerRole },
  subjectPersonId: string,
  resource: string,
  purpose: string,
  at: string,
): AccessLogEntry | null {
  if (viewer.role === 'owner' && viewer.id === subjectPersonId) return null;
  return { viewer_id: viewer.id, viewer_role: viewer.role, subject_person_id: subjectPersonId, resource, purpose, at };
}

// ---------------------------------------------------------------------------
// Safe logging: ids and counts only
// ---------------------------------------------------------------------------

export interface SafeLogEvent {
  event: string;
  ids?: Readonly<Record<string, string>>;
  counts?: Readonly<Record<string, number>>;
}

const ID_LIKE = /^[A-Za-z0-9_\-:.]{1,80}$/;

/** Drops anything that is not an id-shaped string or a number, so content cannot leak into logs. */
export function safeLog(e: SafeLogEvent): string {
  const ids: Record<string, string> = {};
  for (const [k, v] of Object.entries(e.ids ?? {})) if (ID_LIKE.test(v)) ids[k] = v;
  const counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(e.counts ?? {})) if (Number.isFinite(v)) counts[k] = v;
  return JSON.stringify({ event: e.event, ids, counts });
}
