"""Stage C feature export (no model training)."""

import csv
import json

from export_spark_features import columns, flatten, main, readiness


def outcome(spark="s1", completed=True, dataset="live", instance="i1", roles=("Partner", "Ambassador", "Leader")):
    return {
        "spark_id": spark, "instance_id": instance, "place_id": "p", "sector": "energy", "duration_days": 14,
        "trio_score": 0.6, "distinct_clusters": 3, "dataset": dataset, "model_version": "pal-core@0.1.0",
        "completed": completed,
        "trio": [{"person_id": f"secret-{r}", "role": r, "verified_score": 40, "claimed_score": 5, "confidence": 0.5,
                  "fit": 0.4, "similarity": 0.2, "trust": 0.2, "availability": 1} for r in roles],
    }


def test_flatten_drops_person_ids_and_needs_full_trio():
    row = flatten(outcome())
    assert row is not None and row["completed"] == 1
    assert "secret" not in json.dumps(row)
    assert set(row) == set(columns())
    assert flatten(outcome(roles=("Partner", "Leader"))) is None
    assert flatten(outcome(completed=None)) is None


def test_synthetic_rows_never_count_toward_stage_c():
    rows = [outcome(f"s{i}", dataset="synthetic") for i in range(200)] + [outcome("live1")]
    r = readiness(rows, 150)
    assert r["closed_sparks"] == {"i1": 1}
    assert r["stage_c_ready"] == {"i1": False}
    assert readiness([outcome(f"s{i}") for i in range(150)], 150)["stage_c_ready"] == {"i1": True}


def test_cli(tmp_path, capsys):
    src = tmp_path / "o.jsonl"
    src.write_text("\n".join(json.dumps(outcome(f"s{i}", instance="lagos")) for i in range(3)))
    out = tmp_path / "f.csv"
    assert main(["--outcomes", str(src), "--out", str(out)]) == 0
    with out.open() as fh:
        assert len(list(csv.DictReader(fh))) == 3
    summary = json.loads(capsys.readouterr().out)
    assert summary["threshold"] == 150 and summary["rows_out"] == 3
