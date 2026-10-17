import threading


def within(seconds, function):
    """Runs function in a thread and fails if it takes longer than seconds (so a slow solution cannot hang grading)."""
    result, error = [], []

    def run():
        try:
            result.append(function())
        except BaseException as caught:
            error.append(caught)

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    thread.join(seconds)
    assert not thread.is_alive(), f"took longer than {seconds} seconds"
    if error:
        raise error[0]
    return result[0]

import random

from solution import min_meeting_rooms


def brute(meetings):
    points = sorted({t for m in meetings for t in m})
    return max((sum(1 for s, e in meetings if s <= t < e) for t in points), default=0)


def test_examples():
    assert min_meeting_rooms([[9, 12], [10, 11], [11, 13], [13, 14]]) == 2


def test_back_to_back_meetings_share_a_room():
    assert min_meeting_rooms([[1, 5], [5, 8], [8, 9]]) == 1


def test_no_meetings():
    assert min_meeting_rooms([]) == 0


def test_all_overlapping():
    assert min_meeting_rooms([[1, 10], [2, 9], [3, 8], [4, 7]]) == 4


def test_unsorted_input():
    assert min_meeting_rooms([[7, 10], [2, 4], [1, 3], [3, 5]]) == 2


def test_matches_brute_force_on_random_inputs():
    rng = random.Random(30)
    for _ in range(200):
        meetings = []
        for _ in range(rng.randint(1, 10)):
            start = rng.randint(0, 20)
            meetings.append([start, start + rng.randint(1, 6)])
        assert min_meeting_rooms(meetings) == brute(meetings)


def test_many_meetings_are_fast():
    rng = random.Random(31)
    meetings = []
    for _ in range(200_000):
        start = rng.randrange(10 ** 6)
        meetings.append([start, start + rng.randint(1, 50)])
    assert within(3.0, lambda: min_meeting_rooms(meetings)) >= 1
