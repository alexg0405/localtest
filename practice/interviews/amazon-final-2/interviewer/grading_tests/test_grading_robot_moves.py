"""Grading tests for Amazon final round 2. Kept out of the candidate workspace."""
import inspect
import threading
import time

import pytest

from fulfillment.robot_moves import min_moves


def within(seconds, function):
    """Runs function in a thread and fails if it takes longer than seconds (so a slow search cannot hang grading)."""
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


def test_example():
    assert min_moves(["D..#", ".#..", "...P"]) == 5


def test_station_next_to_the_dock():
    assert min_moves(["DP"]) == 1


def test_unreachable_station_returns_minus_one():
    assert min_moves(["D#P"]) == -1
    assert min_moves(["D.#", "###", "..P"]) == -1


def test_no_station_returns_minus_one():
    assert min_moves(["D..", "..."]) == -1


def test_nearest_of_several_stations():
    assert min_moves(["P...D.P", "......."]) == 2


def test_no_diagonal_moves():
    assert min_moves(["D#", "#P"]) == -1


def test_path_must_go_around_shelves():
    assert min_moves(["D....", "####.", "P...."]) == 10
    assert min_moves(["D.#.P", "..#..", "....."]) == 8


def test_missing_dock_raises_value_error():
    with pytest.raises(ValueError):
        min_moves(["..P"])


def test_large_open_grid_is_fast():
    grid = ["D" + "." * 499] + ["." * 500 for _ in range(498)] + ["." * 499 + "P"]
    assert within(4.0, lambda: min_moves(grid)) == 998


def test_large_maze_is_fast():
    rows = []
    for r in range(301):
        if r % 2 == 0:
            rows.append("." * 301)
        else:
            gap = 0 if (r // 2) % 2 == 0 else 300
            rows.append("".join("." if c == gap else "#" for c in range(301)))
    rows[0] = "D" + rows[0][1:]
    rows[300] = rows[300][:300] + "P"
    expected = within(10.0, lambda: min_moves(rows))
    assert expected > 300


# Interviewer's follow-up (revealed at minute 33)

def clears_supported():
    assert "clears" in inspect.signature(min_moves).parameters, "min_moves has no clears parameter"


def test_change_one_clear_opens_a_wall():
    clears_supported()
    assert min_moves(["D#P"], clears=1) == 2
    assert min_moves(["D#P"], clears=0) == -1


def test_change_clears_take_the_shortcut_through_shelves():
    clears_supported()
    grid = ["D....", "####.", "P...."]
    assert min_moves(grid, clears=0) == 10
    assert min_moves(grid, clears=1) == 2


def test_change_each_shelf_uses_a_clear():
    clears_supported()
    assert min_moves(["D##P"], clears=1) == -1
    assert min_moves(["D##P"], clears=2) == 3


def test_change_extra_clears_never_hurt():
    clears_supported()
    assert min_moves(["D..#", ".#..", "...P"], clears=5) == 5


def test_change_large_grid_with_clears_is_fast():
    clears_supported()
    grid = ["D###P" + "#" * 115] + ["#" * 120 for _ in range(119)]
    assert within(10.0, lambda: min_moves(grid, clears=3)) == 4
    assert within(10.0, lambda: min_moves(grid, clears=2)) == -1
