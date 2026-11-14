"""EQ_AUDIT C1/C2: link_events cites only the deciding event and no longer ORs over tiles."""
from engine.verdict.calibrate import calibrate_all
from engine.verdict.link_events import link


def _row(tile, status, best="A", screened=("A", "B", "C")):
    return {"pipeline": "earthquake_coseismic", "tile": tile, "status": status, "raw_p": 0.5,
            "detail": {"decision": {"best_event_id": best}, "forward_screens": [{"event_id": e} for e in screened]}}


def test_only_the_deciding_event_is_linked_not_every_screened_event():                       # C1
    out = link(calibrate_all([_row("t1", "SUPPORTED")]))
    assert [e["event_id"] for e in out["events"]] == ["A"]


def test_one_lucky_tile_among_many_does_not_make_the_event_supporting():                      # C2
    rows = [_row("t0", "SUPPORTED")] + [_row(f"t{i}", "NOT_SUPPORTED") for i in range(1, 20)]
    ev = link(calibrate_all(rows))["events"][0]
    assert ev["any_tile_supporting"] is True and ev["supporting"] is False
    assert ev["tile_counts"]["earthquake_coseismic"] == {"tiles_total": 20, "tiles_tested": 20,
                                                          "tiles_supporting": 1, "supports": False}


def test_majority_of_tested_tiles_supports_and_untested_tiles_do_not_count_against():
    rows = [_row("t1", "SUPPORTED"), _row("t2", "SUPPORTED"), _row("t3", "NOT_SUPPORTED"),
            _row("t4", "INSUFFICIENT_EVIDENCE"), _row("t5", "INSUFFICIENT_EVIDENCE")]
    ev = link(calibrate_all(rows))["events"][0]
    assert ev["supporting"] is True
    assert ev["tile_counts"]["earthquake_coseismic"]["tiles_tested"] == 3


def test_single_tile_behaviour_is_unchanged():
    assert link(calibrate_all([_row("t1", "SUPPORTED")]))["events"][0]["supporting"] is True
    assert link(calibrate_all([_row("t1", "NOT_SUPPORTED")]))["events"][0]["supporting"] is False
