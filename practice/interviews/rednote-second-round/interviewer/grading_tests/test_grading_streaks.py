"""Grading tests for the RedNote second round. Kept out of the candidate workspace."""
import random
import threading
import time

from streaks import posting_streaks
from streaks.posting_streaks import longest_streak

EXAMPLE = [5, 1, 2, 9, 3, 2, 10]


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
    assert longest_streak(EXAMPLE) == 3


def test_several_notes_on_one_day_count_once():
    assert longest_streak([1, 1, 1, 2, 2, 3]) == 3


def test_days_in_any_order():
    assert longest_streak([10, 3, 11, 1, 2, 12, 13]) == 4


def test_one_day():
    assert longest_streak([7]) == 1


def test_no_notes():
    assert longest_streak([]) == 0


def test_a_missed_day_ends_the_streak():
    assert longest_streak([1, 2, 4, 5]) == 2


def test_the_longest_streak_is_last():
    assert longest_streak([0, 5, 6, 7]) == 3


def test_a_long_streak_is_fast():
    days = list(range(200_000)) * 2   # one long streak, every day twice
    random.Random(5).shuffle(days)
    answer, seconds = within(3.0, lambda: longest_streak(days))
    assert answer == 200_000 and seconds < 3.0


def test_large_input_is_fast():
    rng = random.Random(7)
    days = [rng.randrange(1_000_000) for _ in range(300_000)]
    answer, _ = within(3.0, lambda: longest_streak(days))
    assert answer == _brute_streak(days, 0)


# Interviewer's follow-up (revealed at minute 45, or once the tests pass)

def with_freezes():
    function = getattr(posting_streaks, "longest_streak_with_freezes", None)
    assert function is not None, "streaks.posting_streaks.longest_streak_with_freezes does not exist"
    return function


def _brute_streak(days, freezes):
    """Every window of distinct days whose missing days fit in the freezes (fine for small inputs; linear for 0)."""
    posted = sorted(set(days))
    if freezes == 0:
        best = run = 0
        for i, day in enumerate(posted):
            run = run + 1 if i and day == posted[i - 1] + 1 else 1
            best = max(best, run)
        return best
    best = 0
    for left in range(len(posted)):
        for right in range(left, len(posted)):
            span = posted[right] - posted[left] + 1
            if span - (right - left + 1) <= freezes:
                best = max(best, span)
    return best


def test_change_example():
    assert with_freezes()([1, 2, 4, 5, 6, 9], 1) == 6


def test_change_no_freezes_is_the_plain_streak():
    assert with_freezes()(EXAMPLE, 0) == 3


def test_change_freezes_cover_several_gaps():
    assert with_freezes()([1, 3, 5, 7], 3) == 7


def test_change_a_gap_too_big_ends_the_streak():
    assert with_freezes()([1, 5], 2) == 1


def test_change_freezes_dont_reach_past_the_last_note():
    assert with_freezes()([1, 2, 3], 5) == 3


def test_change_several_notes_on_one_day_count_once():
    assert with_freezes()([1, 1, 2, 2, 4, 4], 1) == 4


def test_change_no_notes():
    assert with_freezes()([], 2) == 0


def test_change_matches_every_window_on_random_days():
    rng = random.Random(3)
    function = with_freezes()
    for _ in range(300):
        days = [rng.randrange(40) for _ in range(rng.randrange(1, 25))]
        freezes = rng.randrange(5)
        assert function(days, freezes) == _brute_streak(days, freezes), (days, freezes)


def test_change_large_input_is_fast():
    rng = random.Random(11)
    days = [rng.randrange(600_000) for _ in range(300_000)]
    answer, _ = within(4.0, lambda: with_freezes()(days, 3))
    assert answer >= _brute_streak(days, 0)
