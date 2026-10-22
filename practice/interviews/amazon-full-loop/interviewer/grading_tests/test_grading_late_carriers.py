"""Grading tests for Amazon final round 1. Kept out of the candidate workspace."""
import random
import threading
import time

import pytest

from deliveries import late_carriers
from deliveries.late_carriers import top_late_carriers

EXAMPLE = [("p1", "FastShip", 3, 4), ("p2", "FastShip", 2, 2), ("p3", "QuickBox", 5, 7), ("p4", "QuickBox", 1, 3), ("p5", "Parcelo", 4, 4)]


def within(seconds, function):
    """Runs function in a thread and fails if it takes longer than seconds (so a slow solution cannot hang grading)."""
    result, error = [], []
    thread = threading.Thread(target=lambda: _capture(function, result, error), daemon=True)
    start = time.perf_counter()
    thread.start()
    thread.join(seconds)
    assert not thread.is_alive(), f"took longer than {seconds} seconds"
    if error:
        raise error[0]
    return result[0], time.perf_counter() - start


def _capture(function, result, error):
    try:
        result.append(function())
    except BaseException as caught:  # surfaced in the test thread
        error.append(caught)


def test_example():
    assert top_late_carriers(EXAMPLE, 2) == ["QuickBox", "FastShip"]


def test_ties_are_alphabetical():
    records = [("a", "Zeta", 1, 2), ("b", "Alpha", 1, 2), ("c", "Mid", 1, 2), ("d", "Mid", 1, 3)]
    assert top_late_carriers(records, 3) == ["Mid", "Alpha", "Zeta"]


def test_last_record_for_a_package_wins():
    records = [("p1", "FastShip", 1, 5), ("p1", "FastShip", 1, 1), ("p2", "QuickBox", 1, 2), ("p3", "QuickBox", 1, 1), ("p3", "QuickBox", 1, 4)]
    assert top_late_carriers(records, 5) == ["QuickBox"]


def test_corrected_record_can_move_a_package_to_another_carrier():
    records = [("p1", "FastShip", 1, 5), ("p1", "QuickBox", 1, 5)]
    assert top_late_carriers(records, 2) == ["QuickBox"]


def test_delivered_on_the_promised_day_is_on_time():
    assert top_late_carriers([("p1", "FastShip", 3, 3)], 1) == []


@pytest.mark.parametrize("k, expected", [(10, ["QuickBox", "FastShip"]), (0, []), (-1, [])])
def test_k_out_of_range(k, expected):
    assert top_late_carriers(EXAMPLE, k) == expected


def test_empty_input():
    assert top_late_carriers([], 3) == []


def test_large_input_is_fast():
    rng = random.Random(7)
    records = [(f"p{i}", f"carrier{rng.randrange(3000)}", 5, rng.randrange(10)) for i in range(200_000)]
    answer, seconds = within(3.0, lambda: top_late_carriers(records, 5))
    assert len(answer) == 5 and seconds < 3.0


# Interviewer's follow-up (revealed at minute 33)

def tracker():
    cls = getattr(late_carriers, "LateCarrierTracker", None)
    assert cls is not None, "deliveries.late_carriers.LateCarrierTracker does not exist"
    return cls()


def test_change_tracker_matches_the_batch_answer():
    t = tracker()
    for record in EXAMPLE:
        t.record(*record)
    assert t.top(2) == ["QuickBox", "FastShip"]
    assert t.top(0) == []


def test_change_tracker_applies_corrections():
    t = tracker()
    t.record("p1", "FastShip", 1, 5)
    t.record("p2", "FastShip", 1, 5)
    t.record("p3", "QuickBox", 1, 5)
    assert t.top(2) == ["FastShip", "QuickBox"]
    t.record("p1", "FastShip", 1, 1)   # correction: on time after all
    t.record("p2", "QuickBox", 1, 5)   # correction: another carrier
    assert t.top(2) == ["QuickBox"]


def test_change_tracker_matches_batch_on_random_records():
    rng = random.Random(3)
    records = [(f"p{rng.randrange(300)}", f"c{rng.randrange(20)}", 5, rng.randrange(10)) for _ in range(2000)]
    t = tracker()
    for i, record in enumerate(records, 1):
        t.record(*record)
        if i % 250 == 0:
            assert t.top(4) == top_late_carriers(records[:i], 4)


def test_change_tracker_top_is_fast_after_many_records():
    rng = random.Random(11)
    t = tracker()

    def run():
        for i in range(50_000):
            t.record(f"p{rng.randrange(40_000)}", f"c{rng.randrange(1000)}", 5, rng.randrange(10))
            if i % 50 == 0:
                t.top(5)
        return t.top(5)

    answer, _ = within(4.0, run)
    assert len(answer) == 5
