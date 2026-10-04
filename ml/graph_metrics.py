"""PAL Engine Stage B: per-place graph metrics (batch job, not an edge function).

Reads verified collaboration / funding / referral / membership / endorsement edges (the rows
pal-graph-build writes to pal_graph_edges), and per place computes:

  * community detection (Louvain, seeded, deterministic)
  * brokers: weighted betweenness, consent-filtered, top `ml.max_brokers`
  * structural holes / single points of failure: articulation points and bridges

Output is one JSON document per run, keyed by place, shaped for pal_place_readiness.extras and
pal_gaps. A place is only "enabled" once it passes the Stage B gate (config `ml.*`):
enough nodes, at least `graph_min_communities` communities, and at least
`graph_min_closed_verified_sparks` closed, verified Sparks.

Privacy:
  * Only verified/corroborated edges are used (stingy rule).
  * Community sizes are never emitted (k-anonymity); only the count and modularity.
  * Brokers are emitted only for people with the broker-visibility consent.
  * Person ids appear only in `brokers` and `gaps` (steward-only tables / endpoints).

Usage:
  python ml/graph_metrics.py --edges edges.jsonl --sparks sparks.json \
      --consents broker_consents.json --instance <id> --now 2026-10-01T00:00:00Z --out out.json
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

import networkx as nx
import yaml

REPO = Path(__file__).resolve().parent.parent
MS_PER_MONTH = 2_629_800_000  # 365.25/12 days, identical to pal-core
EDGE_KINDS = {"collaboration", "funding", "referral", "membership", "endorsement"}
COUNTED_LEVELS = {"verified", "corroborated"}


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------


def deep_merge(base: Any, over: Any) -> Any:
    if isinstance(base, dict) and isinstance(over, dict):
        out = dict(base)
        for k, v in over.items():
            out[k] = deep_merge(out[k], v) if k in out else v
        return out
    return base if over is None else over


def load_config(instance_id: str, path: Path | None = None) -> dict[str, Any]:
    """Effective config for one instance (same merge semantics as pal-core resolveInstanceConfig)."""
    raw = yaml.safe_load((path or REPO / "config" / "pal.config.yaml").read_text())
    inst = next((i for i in raw["instances"] if i["id"] == instance_id), None)
    if inst is None:
        raise SystemExit(f"unknown instance: {instance_id}")
    base = {k: v for k, v in raw.items() if k != "instances"}
    merged = deep_merge(base, inst.get("overrides") or {})
    merged["instance"] = {k: v for k, v in inst.items() if k != "overrides"}
    return merged


# ---------------------------------------------------------------------------
# Edges
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Edge:
    source: str
    target: str
    place_id: str
    kind: str
    verification_level: str
    weight: float
    occurred_at: str


def parse_time(s: str) -> float:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000


def decayed_weight(e: Edge, now: str, half_life_months: float) -> float:
    age_months = max(0.0, (parse_time(now) - parse_time(e.occurred_at)) / MS_PER_MONTH)
    return e.weight * math.pow(2, -age_months / half_life_months)


def load_edges(rows: Iterable[dict[str, Any]]) -> tuple[list[Edge], dict[str, int]]:
    """Validate edge rows. Returns kept edges and reject counts (counts only, never content)."""
    kept: list[Edge] = []
    rejected = {"unknown_kind": 0, "not_verified": 0, "self_loop": 0, "malformed": 0}
    for r in rows:
        try:
            e = Edge(
                source=str(r["source_person_id"]),
                target=str(r["target_person_id"]),
                place_id=str(r["place_id"]),
                kind=str(r["kind"]),
                verification_level=str(r["verification_level"]),
                weight=float(r.get("weight", 1.0)),
                occurred_at=str(r["occurred_at"]),
            )
            parse_time(e.occurred_at)
        except (KeyError, TypeError, ValueError):
            rejected["malformed"] += 1
            continue
        if e.kind not in EDGE_KINDS:
            rejected["unknown_kind"] += 1
        elif e.verification_level not in COUNTED_LEVELS:
            rejected["not_verified"] += 1
        elif e.source == e.target:
            rejected["self_loop"] += 1
        elif e.weight > 0:
            kept.append(e)
    return kept, rejected


def build_graph(edges: Iterable[Edge], now: str, half_life_months: float) -> nx.Graph:
    g = nx.Graph()
    for e in edges:
        w = decayed_weight(e, now, half_life_months)
        if g.has_edge(e.source, e.target):
            g[e.source][e.target]["weight"] += w
        else:
            g.add_edge(e.source, e.target, weight=w)
    for _, _, d in g.edges(data=True):
        d["distance"] = 1.0 / d["weight"]
    return g


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------


def communities(g: nx.Graph, seed: int = 42) -> list[set[str]]:
    if g.number_of_edges() == 0:
        return [{n} for n in g.nodes]
    parts = nx.community.louvain_communities(g, weight="weight", seed=seed)
    return sorted((set(p) for p in parts), key=lambda p: (-len(p), min(p)))


def gate(g: nx.Graph, n_communities: int, closed_verified_sparks: int, ml: dict[str, Any]) -> dict[str, Any]:
    largest = max((len(c) for c in nx.connected_components(g)), default=0)
    checks = {
        "min_nodes": largest >= ml["graph_min_nodes"],
        "min_communities": n_communities >= ml["graph_min_communities"],
        "min_closed_verified_sparks": closed_verified_sparks >= ml["graph_min_closed_verified_sparks"],
    }
    return {"enabled": all(checks.values()), "checks": checks}


def place_metrics(
    g: nx.Graph,
    *,
    closed_verified_sparks: int,
    broker_consents: set[str],
    ml: dict[str, Any],
    k_min: int,
    seed: int = 42,
) -> dict[str, Any]:
    parts = communities(g, seed)
    multi = [p for p in parts if len(p) > 1]
    g_state = gate(g, len(multi), closed_verified_sparks, ml)
    largest_cc = max((len(c) for c in nx.connected_components(g)), default=0)
    extras: dict[str, Any] = {
        "graph_enabled": g_state["enabled"],
        "gate": g_state["checks"],
        # Counts below k_min are not emitted as numbers (spec §2.7).
        "nodes": g.number_of_nodes() if g.number_of_nodes() >= k_min else f"fewer than {k_min}",
        "communities": len(multi),
        "modularity": round(nx.community.modularity(g, parts, weight="weight"), 4) if g.number_of_edges() else None,
        "largest_component_share": round(largest_cc / g.number_of_nodes(), 4) if g.number_of_nodes() else None,
        "density": round(nx.density(g), 4) if g.number_of_nodes() > 1 else None,
    }
    if not g_state["enabled"]:
        return {"extras": extras, "brokers": [], "gaps": []}

    member_of = {n: i for i, p in enumerate(parts) for n in p}
    btw = nx.betweenness_centrality(g, weight="distance", normalized=True, seed=None)
    ranked = sorted(
        (n for n in g.nodes if n in broker_consents and btw[n] > 0),
        key=lambda n: (-btw[n], n),
    )
    brokers = [
        {
            "person_id": n,
            "betweenness": round(btw[n], 6),
            "communities_bridged": len({member_of[m] for m in g.neighbors(n)} | {member_of[n]}),
        }
        for n in ranked[: ml["max_brokers"]]
    ]

    gaps: list[dict[str, Any]] = []
    for n in sorted(nx.articulation_points(g)):
        # How many people would be cut off from the largest remaining component.
        h = g.copy()
        h.remove_node(n)
        sizes = sorted((len(c) for c in nx.connected_components(h)), reverse=True)
        cut_off = sum(sizes[1:])
        gaps.append(
            {
                "kind": "single_point_of_failure",
                "person_id": n,
                "consented_visibility": n in broker_consents,
                "cut_off_band": cut_off if cut_off >= k_min else f"fewer than {k_min}",
            }
        )
    for u, v in sorted(tuple(sorted(e)) for e in nx.bridges(g)):
        if member_of[u] != member_of[v]:
            gaps.append({"kind": "sole_bridge_between_communities", "person_ids": [u, v]})
    return {"extras": extras, "brokers": brokers, "gaps": gaps}


def run(
    edge_rows: Iterable[dict[str, Any]],
    *,
    cfg: dict[str, Any],
    now: str,
    closed_verified_sparks: dict[str, int],
    broker_consents: set[str],
    place_ids: set[str] | None = None,
) -> dict[str, Any]:
    edges, rejected = load_edges(edge_rows)
    by_place: dict[str, list[Edge]] = {}
    for e in edges:
        by_place.setdefault(e.place_id, []).append(e)
    places = sorted(place_ids if place_ids is not None else set(by_place))
    results = {}
    for pid in places:
        g = build_graph(by_place.get(pid, []), now, cfg["scoring"]["half_life_months"])
        results[pid] = place_metrics(
            g,
            closed_verified_sparks=closed_verified_sparks.get(pid, 0),
            broker_consents=broker_consents,
            ml=cfg["ml"],
            k_min=cfg["privacy"]["k_min"],
        )
    return {
        "instance_id": cfg["instance"]["id"],
        "model_version": cfg["model_version"],
        "computed_at": now,
        "edges_used": len(edges),
        "edges_rejected": rejected,
        "places": results,
    }


# ---------------------------------------------------------------------------
# I/O
# ---------------------------------------------------------------------------


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def write_database(_result: dict[str, Any]) -> None:
    # STUB(D-001): pal_place_readiness.extras / pal_gaps writes land with the PAL migrations in the
    # ECO platform repo. Until then the job writes JSON and an operator loads it (docs/RUNBOOK.md).
    raise NotImplementedError("database writer pending PAL migrations; use --out")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--edges", type=Path, required=True, help="JSONL of pal_graph_edges rows")
    ap.add_argument("--sparks", type=Path, help='JSON {"<place_id>": <closed verified spark count>}')
    ap.add_argument("--consents", type=Path, help="JSON list of person ids with broker-visibility consent")
    ap.add_argument("--instance", required=True)
    ap.add_argument("--now", required=True, help="ISO timestamp (explicit for reproducibility)")
    ap.add_argument("--config", type=Path)
    ap.add_argument("--out", type=Path, help="Write JSON here (default: stdout)")
    ap.add_argument("--to-db", action="store_true", help="Write to the database (not yet available)")
    a = ap.parse_args(argv)

    cfg = load_config(a.instance, a.config)
    result = run(
        read_jsonl(a.edges),
        cfg=cfg,
        now=a.now,
        closed_verified_sparks=json.loads(a.sparks.read_text()) if a.sparks else {},
        broker_consents=set(json.loads(a.consents.read_text())) if a.consents else set(),
    )
    if a.to_db:
        write_database(result)
    body = json.dumps(result, indent=2, sort_keys=True)
    if a.out:
        a.out.write_text(body + "\n")
    else:
        sys.stdout.write(body + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
