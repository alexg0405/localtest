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

from solution import oranges_rotting


def test_examples():
    assert oranges_rotting([[2, 1, 0], [1, 1, 0], [0, 1, 1]]) == 4
    assert oranges_rotting([[2, 0, 1]]) == -1


def test_no_fresh_oranges_is_zero_minutes():
    assert oranges_rotting([[0, 2, 0]]) == 0
    assert oranges_rotting([[0]]) == 0


def test_fresh_with_no_rotten_never_rots():
    assert oranges_rotting([[1, 1]]) == -1


def test_several_rotten_oranges_spread_at_the_same_time():
    assert oranges_rotting([[2, 1, 1, 1, 2]]) == 2


def test_diagonals_do_not_spread():
    assert oranges_rotting([[2, 0], [0, 1]]) == -1


def test_large_grid_is_fast():
    grid = [[1] * 300 for _ in range(300)]
    grid[0][0] = 2
    assert within(4.0, lambda: oranges_rotting(grid)) == 598
