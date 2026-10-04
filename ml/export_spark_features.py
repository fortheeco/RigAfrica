"""Stage C data export: flatten spark_outcomes rows into a training table. Does NOT train anything.

The GNN (Stage C) is switched on per city only after `ml.stage_c_min_closed_sparks` (default 150)
closed Sparks. This script accumulates the training data and reports readiness per city.

Input: JSONL of spark_outcomes rows (eval/out/spark_outcomes.jsonl, or an export of the table).
Output: CSV with one row per Spark, plus a JSON readiness summary on stdout.

Usage:
  python ml/export_spark_features.py --outcomes spark_outcomes.jsonl --out features.csv [--instance <id>]
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path
from typing import Any

from graph_metrics import load_config, read_jsonl

ROLES = ("Partner", "Ambassador", "Leader")
MEMBER_FIELDS = ("verified_score", "claimed_score", "confidence", "fit", "similarity", "trust", "availability")
BASE_FIELDS = ("spark_id", "instance_id", "place_id", "sector", "duration_days", "trio_score", "distinct_clusters", "dataset", "model_version")


def columns() -> list[str]:
    cols = list(BASE_FIELDS)
    for r in ROLES:
        cols += [f"{r.lower()}_{f}" for f in MEMBER_FIELDS]
    return cols + ["completed"]


def flatten(row: dict[str, Any]) -> dict[str, Any] | None:
    """One feature row per Spark. Person ids are deliberately dropped: the model learns from
    role-level features, not identities. Rows without a full trio or an outcome are skipped."""
    trio = row.get("trio") or []
    by_role = {m.get("role"): m for m in trio}
    if row.get("completed") is None or any(r not in by_role for r in ROLES):
        return None
    out: dict[str, Any] = {k: row.get(k) for k in BASE_FIELDS}
    for r in ROLES:
        for f in MEMBER_FIELDS:
            out[f"{r.lower()}_{f}"] = by_role[r].get(f)
    out["completed"] = int(bool(row["completed"]))
    return out


def readiness(rows: list[dict[str, Any]], threshold: int) -> dict[str, Any]:
    """Closed Sparks per city (instance), and whether Stage C may be switched on."""
    counts: dict[str, int] = {}
    for r in rows:
        if r.get("completed") is not None and r.get("dataset") != "synthetic":
            counts[r["instance_id"]] = counts.get(r["instance_id"], 0) + 1
    return {
        "threshold": threshold,
        "closed_sparks": counts,
        "stage_c_ready": {k: v >= threshold for k, v in counts.items()},
        "note": "synthetic rows never count toward the Stage C threshold",
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--outcomes", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--instance", help="Config instance for the Stage C threshold (default: first)")
    ap.add_argument("--config", type=Path)
    a = ap.parse_args(argv)

    rows = read_jsonl(a.outcomes)
    instance = (a.instance or rows[0]["instance_id"]) if rows else a.instance
    threshold = load_config(instance, a.config)["ml"]["stage_c_min_closed_sparks"] if instance else 150
    feats = [f for f in (flatten(r) for r in rows) if f is not None]
    with a.out.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=columns())
        w.writeheader()
        w.writerows(feats)
    summary = {"rows_in": len(rows), "rows_out": len(feats), **readiness(rows, threshold)}
    sys.stdout.write(json.dumps(summary, indent=2, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
