"""A5: a quiet tile reports NO_SIGNAL as its best verdict — it is an answer, not an abstention —
and the priority table puts a completed quiet outcome ABOVE a rejection and every gap status.

The engine's semantics (engine/verdict/select.py): PRIORITY ranks SUPPORTED > UNCATALOGUED_CANDIDATE >
POSSIBLE > NO_SIGNAL > NOT_SUPPORTED > INSUFFICIENT_EVIDENCE > PENDING > NOT_RUN > NOT_APPLICABLE >
NOT_MODELLED > ERROR. "quiet" is a DECISION TIER: a tile whose best verdict is quiet is REPORTED
(never abstained) but is not "above the threshold" of hazard tiers — it is listed in `quiet`."""
from engine.verdict.select import DECISION_TIERS, PRIORITY, select


def _row(pipeline, status, tier, raw_p=None, tile="T1"):
    return {"tile": tile, "pipeline": pipeline, "status": status, "tier": tier, "raw_p": raw_p}


QUIET_TILE = [
    _row("earthquake_coseismic", "NO_SIGNAL", "quiet"),
    _row("landslide", "NOT_APPLICABLE", "not_applicable"),
    _row("volcanic_deformation", "NOT_MODELLED", "not_modelled"),
    _row("tsunami_ocean_evidence", "NOT_APPLICABLE", "not_applicable"),
]


def test_no_signal_is_in_the_priority_table_above_not_supported_and_below_possible():
    assert PRIORITY["POSSIBLE"] < PRIORITY["NO_SIGNAL"] < PRIORITY["NOT_SUPPORTED"]
    assert PRIORITY["NO_SIGNAL"] < PRIORITY["INSUFFICIENT_EVIDENCE"]
    assert PRIORITY["NO_SIGNAL"] < PRIORITY["NOT_APPLICABLE"] < PRIORITY["NOT_MODELLED"]
    assert "quiet" in DECISION_TIERS            # a decision tier, not a hazard level


def test_quiet_tile_reports_no_signal_as_best_and_is_not_abstained():
    out = select(QUIET_TILE)
    assert out["best_by_tile"]["T1"]["status"] == "NO_SIGNAL"
    assert out["best_by_tile"]["T1"]["pipeline"] == "earthquake_coseismic"
    assert out["abstained"] == []               # a quiet answer is still an answer
    assert out["quiet"] == ["T1"]               # reported separately, never as a hazard tier
    assert out["above_threshold"] == []         # quiet rows are excluded from the hazard tiers


def test_order_of_rows_does_not_matter():
    assert select(list(reversed(QUIET_TILE)))["best_by_tile"]["T1"]["status"] == "NO_SIGNAL"


def test_a_positive_verdict_beats_quiet_but_a_rejection_does_not():
    rows = QUIET_TILE + [_row("y", "SUPPORTED", "supported", 0.9)]
    assert select(rows)["best_by_tile"]["T1"]["status"] == "SUPPORTED"
    rows = QUIET_TILE + [_row("x", "POSSIBLE", "candidate", 0.5)]
    assert select(rows)["best_by_tile"]["T1"]["status"] == "POSSIBLE"
    # a rejection ranks BELOW a completed quiet outcome: "we looked, nothing moved" says more
    # than "we looked and the screens did not pass" — but the rejection is still reportable
    rows = QUIET_TILE + [_row("y", "NOT_SUPPORTED", "not_supported", 0.1)]
    out = select(rows)
    assert out["best_by_tile"]["T1"]["status"] == "NO_SIGNAL"
    assert [r["status"] for r in out["above_threshold"]] == ["NOT_SUPPORTED"]
    assert out["quiet"] == ["T1"]               # the best verdict is quiet; the rejection rides along


def test_quiet_beats_insufficient_evidence_and_even_a_strict_threshold_reports_it():
    rows = QUIET_TILE + [_row("z", "INSUFFICIENT_EVIDENCE", "insufficient")]
    assert select(rows)["best_by_tile"]["T1"]["status"] == "NO_SIGNAL"
    # even asked for a positive finding only, a quiet answer is REPORTED (never abstained) —
    # abstention is for tiles whose best is a non-decision (pending / insufficient / error)
    strict = select(QUIET_TILE, threshold_tier="supported")
    assert strict["abstained"] == [] and strict["quiet"] == ["T1"]
    gap = [_row("z", "INSUFFICIENT_EVIDENCE", "insufficient")]
    assert select(gap)["abstained"] and select(gap)["abstained"][0]["tile"] == "T1"


def test_an_unknown_status_ranks_last_not_ahead_of_a_real_verdict():
    rows = [_row("a", "SOMETHING_NEW", "unknown"), _row("b", "NOT_MODELLED", "not_modelled")]
    assert select(rows)["best_by_tile"]["T1"]["status"] == "NOT_MODELLED"
