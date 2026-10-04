// Shared test fixtures. Instance ids here are synthetic on purpose: core code must not care.
import { DEFAULT_SETTINGS, resolveInstanceConfig } from '../src/config.ts';
import type { PalConfig, ResolvedConfig } from '../src/config.ts';
import type { VerifiedEvidence } from '../src/scoring.ts';

export const NOW = '2026-10-01T00:00:00.000Z';

export function testConfig(over: Partial<PalConfig> = {}): PalConfig {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    instances: [
      { id: 'alpha', country: 'ZZ', place_type: 'district', currency: 'XXX', languages: ['en'], regulator: 'TEST' },
    ],
    ...over,
  };
}

export function cfg(over: Partial<PalConfig> = {}): ResolvedConfig {
  return resolveInstanceConfig(testConfig(over), 'alpha');
}

let seq = 0;
export function ev(over: Partial<VerifiedEvidence> = {}): VerifiedEvidence {
  seq += 1;
  return {
    id: `ev-${seq}`,
    axis: 'execution',
    sector: 'agriculture',
    evidence_type: 'sprint_closed_verified',
    quality: null,
    verification_level: 'verified',
    occurred_at: NOW,
    verifier_id: `verifier-${seq}`,
    source_ref: `eco_events:${seq}`,
    ...over,
  };
}

export function monthsBefore(iso: string, months: number): string {
  return new Date(Date.parse(iso) - months * 2_629_800_000).toISOString();
}

export function daysBefore(iso: string, days: number): string {
  return new Date(Date.parse(iso) - days * 86_400_000).toISOString();
}
