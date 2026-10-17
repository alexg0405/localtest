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

from solution import merge


def test_examples():
    assert merge([[6, 8], [1, 3], [2, 4], [9, 10]]) == [[1, 4], [6, 8], [9, 10]]


def test_touching_intervals_merge():
    assert merge([[1, 5], [5, 7]]) == [[1, 7]]


def test_nested_intervals():
    assert merge([[1, 10], [2, 3], [4, 8]]) == [[1, 10]]


def test_empty_and_single():
    assert merge([]) == []
    assert merge([[4, 4]]) == [[4, 4]]


def test_a_later_interval_can_extend_the_end():
    assert merge([[1, 4], [2, 3], [3, 9], [10, 11]]) == [[1, 9], [10, 11]]


def test_negative_numbers():
    assert merge([[-5, -1], [-2, 0], [3, 4]]) == [[-5, 0], [3, 4]]


def test_many_intervals_are_fast():
    rng = random.Random(6)
    intervals = []
    for _ in range(200_000):
        start = rng.randrange(10 ** 7)
        intervals.append([start, start + rng.randrange(20)])
    result = within(3.0, lambda: merge(intervals))
    assert all(a[1] < b[0] for a, b in zip(result, result[1:]))
