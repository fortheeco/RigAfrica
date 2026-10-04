"""Stage B graph metrics on synthetic graphs."""

import copy
import json

import pytest

from graph_metrics import Edge, build_graph, decayed_weight, load_config, load_edges, main, place_metrics, run

NOW = "2026-10-01T00:00:00Z"


@pytest.fixture(scope="module")
def cfg():
    raw = load_config("lagos")  # any configured instance; values are the shared defaults
    c = copy.deepcopy(raw)
    c["ml"]["graph_min_nodes"] = 10
    return c


def edge(a, b, place="pl-1", kind="collaboration", level="verified", w=1.0, at="2026-09-01T00:00:00Z"):
    return {"source_person_id": a, "target_person_id": b, "place_id": place, "kind": kind,
            "verification_level": level, "weight": w, "occurred_at": at}


def two_cliques_with_broker(n=6):
    """Clique A (a0..), clique B (b0..), joined only through broker 'x'."""
    rows = []
    for side in "ab":
        nodes = [f"{side}{i}" for i in range(n)]
        rows += [edge(u, v) for i, u in enumerate(nodes) for v in nodes[i + 1:]]
    rows += [edge("x", "a0"), edge("x", "b0")]
    return rows


def test_unverified_unknown_and_self_loops_are_dropped_and_counted():
    kept, rejected = load_edges([
        edge("a", "b"), edge("a", "c", level="unverified"), edge("a", "a"),
        edge("a", "d", kind="dm_thread"), {"source_person_id": "a"},
    ])
    assert len(kept) == 1
    assert rejected == {"unknown_kind": 1, "not_verified": 1, "self_loop": 1, "malformed": 1}


def test_decay_halves_at_half_life():
    from datetime import datetime, timezone

    # Exactly 18 months (of 2_629_800_000 ms, as in pal-core) before NOW.
    now_ms = datetime.fromisoformat(NOW.replace("Z", "+00:00")).timestamp() * 1000
    then = datetime.fromtimestamp((now_ms - 18 * 2_629_800_000) / 1000, tz=timezone.utc).isoformat()
    e = Edge("a", "b", "p", "funding", "verified", 2.0, then)
    assert decayed_weight(e, NOW, 18) == pytest.approx(1.0, abs=1e-9)


def test_parallel_edges_accumulate_weight():
    kept, _ = load_edges([edge("a", "b", w=1, at=NOW), edge("b", "a", w=2, kind="referral", at=NOW)])
    g = build_graph(kept, NOW, 18)
    assert g.number_of_edges() == 1
    assert g["a"]["b"]["weight"] == pytest.approx(3.0)


def test_communities_brokers_and_single_points_of_failure(cfg):
    kept, _ = load_edges(two_cliques_with_broker())
    g = build_graph(kept, NOW, 18)
    out = place_metrics(g, closed_verified_sparks=1, broker_consents={"x", "a0", "b0"}, ml=cfg["ml"], k_min=10)
    assert out["extras"]["graph_enabled"] is True
    assert out["extras"]["communities"] >= 2
    assert out["brokers"][0]["person_id"] == "x"
    assert out["brokers"][0]["communities_bridged"] >= 2
    spof = {gp["person_id"] for gp in out["gaps"] if gp["kind"] == "single_point_of_failure"}
    assert {"x", "a0", "b0"} <= spof
    assert any(gp["kind"] == "sole_bridge_between_communities" for gp in out["gaps"])


def test_brokers_are_consent_filtered(cfg):
    kept, _ = load_edges(two_cliques_with_broker())
    g = build_graph(kept, NOW, 18)
    out = place_metrics(g, closed_verified_sparks=1, broker_consents={"a0"}, ml=cfg["ml"], k_min=10)
    assert [b["person_id"] for b in out["brokers"]] == ["a0"]


def test_gate_blocks_small_graphs_and_places_without_closed_sparks(cfg):
    kept, _ = load_edges(two_cliques_with_broker())
    g = build_graph(kept, NOW, 18)
    no_sparks = place_metrics(g, closed_verified_sparks=0, broker_consents={"x"}, ml=cfg["ml"], k_min=10)
    assert no_sparks["extras"]["graph_enabled"] is False
    assert no_sparks["brokers"] == [] and no_sparks["gaps"] == []
    tiny_kept, _ = load_edges([edge("a", "b"), edge("b", "c")])
    tiny = place_metrics(build_graph(tiny_kept, NOW, 18), closed_verified_sparks=5, broker_consents=set(), ml=cfg["ml"], k_min=10)
    assert tiny["extras"]["graph_enabled"] is False
    assert tiny["extras"]["nodes"] == "fewer than 10"


def test_no_community_sizes_are_emitted(cfg):
    kept, _ = load_edges(two_cliques_with_broker())
    out = place_metrics(build_graph(kept, NOW, 18), closed_verified_sparks=1, broker_consents=set(), ml=cfg["ml"], k_min=10)
    assert set(out["extras"]) == {"graph_enabled", "gate", "nodes", "communities", "modularity", "largest_component_share", "density"}


def test_run_is_deterministic_and_per_place(cfg):
    rows = two_cliques_with_broker() + [edge("p", "q", place="pl-2")]
    a = run(rows, cfg=cfg, now=NOW, closed_verified_sparks={"pl-1": 1}, broker_consents={"x"})
    b = run(rows, cfg=cfg, now=NOW, closed_verified_sparks={"pl-1": 1}, broker_consents={"x"})
    assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)
    assert set(a["places"]) == {"pl-1", "pl-2"}
    assert a["places"]["pl-2"]["extras"]["graph_enabled"] is False


def test_cli_writes_json(tmp_path):
    edges = tmp_path / "edges.jsonl"
    edges.write_text("\n".join(json.dumps(r) for r in two_cliques_with_broker()))
    (tmp_path / "sparks.json").write_text(json.dumps({"pl-1": 1}))
    (tmp_path / "consents.json").write_text(json.dumps(["x"]))
    out = tmp_path / "out.json"
    assert main(["--edges", str(edges), "--sparks", str(tmp_path / "sparks.json"), "--consents", str(tmp_path / "consents.json"),
                 "--instance", "lagos", "--now", NOW, "--out", str(out)]) == 0
    doc = json.loads(out.read_text())
    assert doc["edges_used"] > 0 and "pl-1" in doc["places"]


def test_database_writer_is_an_explicit_stub(tmp_path):
    edges = tmp_path / "e.jsonl"
    edges.write_text(json.dumps(edge("a", "b")))
    with pytest.raises(NotImplementedError):
        main(["--edges", str(edges), "--instance", "lagos", "--now", NOW, "--to-db"])
