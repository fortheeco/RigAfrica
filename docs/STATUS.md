# PAL Engine: build status

_Phase 1 (Stage A) is partially built. Phase 2 (Stage B) scaffold is built. Phase 3 is data
accumulation only._

**Blocker:** `fortheeco/eco-civic-console` (the Lovable-synced ECO repo) wasn't accessible, so
everything that depends on the platform schema is waiting (D-001). Everything that doesn't is
built and tested here.

## Phase 1 acceptance tests

| # | test | status | where |
|---|------|--------|-------|
| 1 | Decay: 18-month-old event = exactly ½ of fresh | ✅ pass | `packages/pal-core/test/scoring.test.ts` "DECAY" |
| 2 | Stingy: claimed-only → V = 0 everywhere, incl. matching explanations | ✅ pass | `scoring.test.ts` "STINGY", `matching.test.ts` "STINGY in matching" |
| 3 | Separation: no PAL write to civic_score / eco_vitality / non-PAL tables | ◐ static scan passes; **RLS half pending migrations** | `guards.test.ts` "SEPARATION" |
| 4 | k-anonymity incl. differencing across sector filters | ✅ pass (core). API-level re-test pending `pal-api` | `readiness.test.ts` "K-ANON", `eval.test.ts` |
| 5 | Consent: reject none/revoked; revoke → purge + recompute within window (simulated clock) | ✅ pass (core pipeline). Edge-function wiring pending | `privacy.test.ts` "CONSENT" |
| 6 | Non-member: unmatched contact hashes never persisted | ✅ pass (core). Alias normalisation is a STUB | `privacy.test.ts` "NON-MEMBER" |
| 7 | Allowlist: protected-attribute-like extraction rejected and counted | ✅ pass | `extraction.test.ts` "ALLOWLIST" |
| 8 | Match: exactly one P/A/L, no duplicate person, ≥ 2 clusters, claimed vs verified marked | ✅ pass | `matching.test.ts` "MATCH" |
| 9 | Funding gate: funded Spark fails while cap null; no open with 0 verifiers | ✅ pass (core). Endpoint wiring pending | `sparks.test.ts` "FUNDING GATE" |
| 10 | Idempotency: same evidence_ref → no duplicates | ✅ pass (planner). DB unique index pending migrations | `extraction.test.ts` "IDEMPOTENCY" |
| 11 | Config: instance config changes outputs, no instance id in code | ✅ pass | `config.test.ts` "CONFIG", `guards.test.ts` "CONFIG" |
| 12 | Access log: steward view logs, owner view doesn't | ✅ pass (rule). Table write pending `pal-api` | `privacy.test.ts` "ACCESS-LOG" |
| 13 | Eval harness end to end, writes fairness report | ✅ pass | `eval/test/eval.test.ts` "EVAL" |

Current counts: **pal-core 82 tests, eval 8, ml 13: all passing.** The pal-core suite also passes
under Deno 2.9.

## Built

- `packages/pal-core`: config schema and validation with per-instance overrides; scoring (V, C,
  B, decay, confidence, roles, states, evidence lines, disputes, history); readiness (TR,
  missing roles, blocked Sparks, k-anonymous public cells); matching (trio search, exclusions,
  explanations, `Embedder` interface, `FakeEmbedder`); extraction schema (allowlist,
  protected/private rejection, language weighting, idempotent upsert planner); privacy (consent
  gate, handle proof via bio-code, purge planner, member-only contact matching, k-anon bands,
  access-log rule, safe logger); Spark gates (lifecycle, funding cap, split lock, verifier
  coverage, steward approval).
- `eval/`: seeded generator over real place fixtures with fake people; metrics; fairness audit;
  language gate.
- `ml/`: Stage B graph metrics with a per-place gate, and the Stage C feature export.
- `docs/pal-api.openapi.yaml`: full §7 contract, lints clean with Redocly, with conformance tests.
- CI workflow, RUNBOOK, DECISIONS.

## Not built yet (needs eco-civic-console)

- `supabase/migrations/*_pal_*.sql`: `pal_consents`, `pal_signals`, `pal_profiles`,
  `pal_profile_history`, `pal_disputes`, `pal_access_log`, `pal_places`, `pal_place_readiness`,
  `pal_gaps`, `pal_graph_edges`, `pal_instance_config`, `pal_fairness_reports`, `pal_purge_audit`,
  `pal_tombstones`, `spark_*` (Spark fields linked to the existing sprint cycle), `spark_outcomes`.
  RLS on all of them, plus the RLS half of the separation test.
- Edge functions: `pal-consent-connect`, `pal-purge-on-revoke`, `pal-ingest-signals`,
  `pal-score-recompute`, `pal-graph-build`, `pal-map-aggregate`, `spark-brief-draft`,
  `spark-propose-trio`, `spark-settle`, `pal-api`. All of them would be thin I/O wrappers around
  `pal-core`.
- A real `Embedder` (env-configured provider), and the Civic LLM hook in `spark-brief-draft`.

## Stubs (`STUB(...)` in code)

| where | why | unblock |
|-------|-----|---------|
| `pal-core/src/privacy.ts` `normaliseEmailAlias`, `normalisePhoneAlias` | eco-id-resolve's normaliser isn't visible; hashes must byte-match | import eco-id-resolve's shared normaliser |
| `pal-core/src/sparks.ts` `countActiveVerifiers` input shape | the `verifier_assignments` schema isn't visible | an adapter from the real table |
| `ml/graph_metrics.py` `write_database` | PAL migrations don't exist yet | write to `pal_place_readiness` / `pal_gaps` |
| `pal-core/test/guards.test.ts` `ALLOWED_EXTERNAL_CALLS` (empty) | the existing payout/release entry point is unknown | add the one RPC that `spark-settle` may call |

## Open risks and product decisions

1. **Readiness targets ≤ k_min (D-021).** With the defaults, nearly every pilot cell publishes a
   TR band, not an exact TR. Decide: raise the targets, lower `k_min`, or accept bands.
2. **Protected lexicon breadth (D-016).** It rejects gender terms and some ethnic names that are
   also place names. Have regional reviewers check it per language.
3. **Claimed-only people can be proposed for trios (D-025).** This follows the spec (B uses
   V + 0.4·C), and explanations label them clearly. Decide whether stewards want a verified floor.
4. **Eval ground truth is simulated (D-033).** The metrics validate the pipeline, not real-world
   accuracy.
5. **Event-record fields unverified.** Scoring assumes each ECO event exposes a verification level
   (unverified/verified/corroborated), an optional quality in [0,1], a verifier id and a
   timestamp. If eco_events lacks a verification level, that's a §9 STOP.
