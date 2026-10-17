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

import copy
import random

from solution import num_islands


def g(*rows):
    return [list(row) for row in rows]


def test_example():
    assert num_islands(g("1100", "0101", "1001")) == 3


def test_all_water_and_empty():
    assert num_islands(g("000", "000")) == 0
    assert num_islands([]) == 0


def test_one_big_island():
    assert num_islands(g("111", "111")) == 1


def test_diagonals_do_not_connect():
    assert num_islands(g("101", "010", "101")) == 5


def test_winding_island():
    assert num_islands(g("11110", "00010", "11110", "10000", "11111")) == 1


def test_large_island_does_not_overflow_the_stack():
    grid = [["1"] * 200 for _ in range(200)]
    assert within(4.0, lambda: num_islands(grid)) == 1


def test_large_random_grid_is_fast():
    rng = random.Random(4)
    grid = [["1" if rng.random() < 0.45 else "0" for _ in range(400)] for _ in range(400)]
    answer = within(5.0, lambda: num_islands(copy.deepcopy(grid)))
    assert answer > 1000
