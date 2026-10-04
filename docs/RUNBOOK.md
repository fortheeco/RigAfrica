# PAL Engine runbook

How to run, test, configure, deploy, rotate keys and purge. See `docs/STATUS.md` for what is
built and `docs/DECISIONS.md` for every judgment call.

> **Where this code lives.** It's currently built in `fortheeco/RigAfrica` on branch
> `claude/pal-engine-backend-tluaxv`, because the ECO platform repo (`fortheeco/eco-civic-console`)
> wasn't accessible to the build session (D-001). The directories below are self-contained.
> Porting them is a copy (see §9). Migrations and edge functions aren't written yet because they
> depend on the platform schema.

## 1. Layout

| path | what | runtime |
|------|------|---------|
| `config/pal.config.yaml` | every tunable; instances; validated by `pal-core` | — |
| `packages/pal-core/` | pure scoring, readiness, matching, extraction schema, privacy and Spark gates. No I/O, no runtime deps | Node ≥ 22.18 and Deno 2 |
| `eval/` | synthetic data generator, metrics, fairness audit, language gate | Node ≥ 22.18 |
| `ml/` | Stage B graph metrics (NetworkX) and the Stage C feature export | Python 3.11 |
| `docs/pal-api.openapi.yaml` | API contract for the Lovable UI | — |
| `.github/workflows/pal-engine.yml` | CI: lint, typecheck, tests, Deno check, eval run, pytest | GitHub Actions |

## 2. Run and test locally

```bash
# pal-core: typecheck + lint (no `any`, no console, no ambient clock) + all tests, including the
# repo-wide separation / instance-id guards and the OpenAPI conformance tests
cd packages/pal-core && npm ci && npm run check

# Deno compatibility (edge-function runtime)
deno check packages/pal-core/src/index.ts
# tests also run under Deno; --no-check only because test files use node types for import.meta
(cd packages/pal-core && deno test --no-check --allow-read --allow-env test/)

# eval harness: tests, then a full run writing eval/out/*.json
cd eval && npm ci && npm run check && npm run eval
node src/run.ts --seed 7 --members-per-place 200 --out /tmp/pal-eval   # options

# ml
pip install -r ml/requirements.txt && python -m pytest ml/tests -q
```

Node runs the `.ts` files directly through built-in type stripping, so there's no build step.
Don't add enums, namespaces or parameter properties: `erasableSyntaxOnly` enforces this.

## 3. Evaluation and fairness

`npm run eval` writes three files to `eval/out/`:

- `eval-report.json`: role calibration (per-role precision and recall, ECE, confidence bins),
  precision@k of trio proposals, Spark completion lift versus random matching, 30-day map
  stability, the language-gate status per configured language, and Sparks blocked by the
  verifier gate.
- `fairness-report.json`: matches the OpenAPI `FairnessReport` schema. It gives the median
  top-match-score gap between low- and high-footprint members (overall and by place) and by
  optional self-reported gender. Any gap over `fairness.max_median_gap` (15) is flagged. Groups
  under `k_min` are banded and get no median.
- `spark_outcomes.jsonl`: rows in the shape of the `spark_outcomes` table (synthetic).

Serving the report: once migrations exist, the report is inserted into `pal_fairness_reports`
(service role), and `GET /admin/fairness` returns the latest row for the instance. Until then,
share the JSON file directly.

**Language promotion.** Put labelled data in `eval/labelled/<lang>.jsonl` (gitignored; format in
`eval/src/language-gate.ts`). A language passes when `sector_interest` and `affiliation` each have
≥ 100 labelled items with precision ≥ 0.8. Promotion is a reviewed config change: add the language
to `extraction.validated_languages`, either globally or in that instance's `overrides`. English is
validated by default (D-007), even though the gate reports `no_data` for it until labelled English
data is added.

## 4. Stage B graph job (`ml/graph_metrics.py`)

A **batch job, not an edge function**. It needs Python 3.11 with networkx and PyYAML. The host
isn't decided. Any of these works:

- a scheduled GitHub Actions workflow with database credentials in repository secrets,
- a container job (Cloud Run Jobs, Fly Machines, ECS scheduled task, or similar) on a nightly cron,
- an operator running it by hand during the pilot.

Inputs (exports of PAL tables, as JSON):

```bash
python ml/graph_metrics.py \
  --edges edges.jsonl            # pal_graph_edges rows for the instance
  --sparks closed_sparks.json    # {"<place_id>": <closed, verified Spark count>}
  --consents brokers.json        # person ids with the broker-visibility consent
  --instance <instance-id> --now 2026-10-01T00:00:00Z --out graph.json
```

A place's output is `enabled` only once it passes the gate in config `ml.*`. Load
`places.<id>.extras` into `pal_place_readiness.extras`, and `brokers` and `gaps` into `pal_gaps`
(steward-only RLS). `--to-db` is a `STUB` until the migrations exist (D-040).

**Stage C** (GNN) is not built. `ml/export_spark_features.py` turns `spark_outcomes` into a
role-level feature table (no person ids) and reports per-city readiness against
`ml.stage_c_min_closed_sparks`. Synthetic rows never count.

## 5. Configuration

- Edit `config/pal.config.yaml`. `pal-core` `validateConfig` rejects unknown keys, a non-zero
  unverified multiplier, `purge_days` > 30, and matching weights that don't sum to 1.
  `packages/pal-core/test/config.test.ts` fails if the YAML is invalid or drifts from
  `DEFAULT_SETTINGS`.
- Per-instance values go in `instances[].overrides` (deep-merged, then validated). At runtime,
  `PUT /admin/config` stores overrides with optimistic versioning and validates through the same
  function.
- **Before any funded Spark in an instance**, set `sparks.funding_cap` and
  `sparks.value_split_defaults` in that instance's overrides. Until then funded drafts fail with
  `funding_cap_unset` and unfunded Sparks still work.
- **Never** add instance-specific code paths. The guard test fails on any instance id (or
  "warri") in PAL code. Places are data (`pal_places`), with `target_profile` naming a
  `readiness_targets` entry.
- `readiness_targets` are pilot placeholders. Note D-021: with targets at or below `k_min`, most
  cells publish a TR band rather than an exact TR.

## 6. Secrets and environment

Everything goes in server-side environment variables (Supabase secrets for edge functions) and
is never committed.

| variable | used by | notes |
|----------|---------|-------|
| `PAL_EXTRACTION_MODEL` | pal-ingest-signals | model id; never hardcoded |
| `PAL_EXTRACTION_API_KEY` | pal-ingest-signals | LLM provider key |
| `PAL_EMBEDDING_PROVIDER`, `PAL_EMBEDDING_MODEL`, `PAL_EMBEDDING_API_KEY` | spark-propose-trio | real `Embedder`; tests use `FakeEmbedder` |
| `ECO_ALIAS_PEPPER` (exact name per eco-id-resolve) | pal-consent-connect (contacts) | **the same** HMAC pepper as eco-id-resolve; read, never redefined |
| `SUPABASE_SERVICE_ROLE_KEY` | compute functions | service role, used only for compute jobs |
| OAuth client ids and secrets per source | pal-consent-connect | official APIs only |

```bash
supabase secrets set PAL_EXTRACTION_MODEL=<model-id> PAL_EXTRACTION_API_KEY=<key>
```

## 7. Rotating keys

- **LLM and embedding keys**: set the new secret, redeploy the affected functions
  (`supabase functions deploy pal-ingest-signals spark-propose-trio`), then revoke the old key at
  the provider. Changing the embedding model invalidates stored embeddings, so recompute them
  before matching.
- **app_api_keys**: issue a new scoped key and give it to the app. Once traffic has moved, set
  the old key's expiry or revocation (same table, existing ECO tooling).
- **OAuth client secrets**: rotate at the provider, update the secret, redeploy
  `pal-consent-connect`. Existing user tokens keep working or are refreshed per provider rules.
- **Alias pepper**: owned by eco-id-resolve. Rotating it re-keys every alias hash platform-wide,
  so coordinate with the ECO ID owners. PAL stores no contact hashes at rest (unmatched hashes are
  dropped at once; matched ones become person ids), so PAL itself has nothing to re-hash.

## 8. Purge, export and delete

- `pal-purge-on-revoke` runs on revoke (event) and daily (schedule). It deletes **all** derived
  rows of a revoked (person, source) on the first run (`planPurge`), appends an audit row,
  triggers a recompute, and alerts on `overdue` (past `purge_days`, at most 30).
- Manual purge for one person and source: call the function with `{person_id, source}` using the
  service role. It's idempotent.
- Verify after a purge: `GET /me/learned?source=<source>` returns nothing, and `pal_profiles.computed_at`
  is after the revocation.
- `DELETE /me` removes the profile, signals, edges and consents, and keeps a non-identifying
  tombstone (random id, timestamp, counts).
- Logs carry ids and counts only (`safeLog`). Never log content, handles or contact values.

## 9. Porting into eco-civic-console (when access is granted)

1. Copy `packages/pal-core`, `eval`, `ml`, `config/pal.config.yaml`, `docs/pal-api.openapi.yaml`,
   `docs/RUNBOOK.md`, `docs/DECISIONS.md`, `docs/STATUS.md` and the workflow, unchanged.
2. Do the Section 0 inspection there: `eco_events` verification and quality fields,
   `verifier_assignments` geography, `app_api_keys` scopes, `eco-id-resolve` normaliser and pepper,
   the civic_score pipeline, and the sprint, fund-pool and payout entry points. Stop on the §9
   conditions.
3. Replace the `STUB`s listed in `docs/STATUS.md` with imports of the real code.
4. Write `supabase/migrations/YYYYMMDDHHMM_pal_*.sql` (additive only, RLS on every table) and the
   edge functions. The guard tests already scan both directories.
5. Applying migrations: with Lovable's GitHub sync, migrations committed under
   `supabase/migrations` are applied by Lovable's Supabase integration, or by an operator running
   `supabase db push --linked`. **Confirm which one this project uses before merging.** Deploy
   functions with `supabase functions deploy <name>`.
