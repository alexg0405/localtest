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

from solution import find_order


def valid(n, prerequisites, order):
    if sorted(order) != list(range(n)):
        return False
    position = {course: i for i, course in enumerate(order)}
    return all(position[b] < position[a] for a, b in prerequisites)


def test_examples():
    assert valid(3, [[1, 0], [2, 1]], find_order(3, [[1, 0], [2, 1]]))
    assert find_order(2, [[0, 1], [1, 0]]) == []


def test_no_prerequisites():
    assert valid(4, [], find_order(4, []))


def test_branching_prerequisites():
    prerequisites = [[1, 0], [2, 0], [3, 1], [3, 2]]
    assert valid(4, prerequisites, find_order(4, prerequisites))


def test_self_prerequisite_is_impossible():
    assert find_order(1, [[0, 0]]) == []


def test_cycle_in_one_part_of_the_graph():
    assert find_order(5, [[1, 0], [2, 3], [3, 4], [4, 2]]) == []


def test_duplicate_prerequisites():
    assert valid(2, [[1, 0], [1, 0]], find_order(2, [[1, 0], [1, 0]]))


def test_random_dags_have_valid_orders():
    rng = random.Random(21)
    for _ in range(50):
        n = rng.randint(1, 30)
        ranks = list(range(n))
        rng.shuffle(ranks)
        prerequisites = [[a, b] for a in range(n) for b in range(n) if ranks[b] < ranks[a] and rng.random() < 0.1]
        assert valid(n, prerequisites, find_order(n, prerequisites))


def test_long_chain_is_fast():
    n = 100_000
    prerequisites = [[i + 1, i] for i in range(n - 1)]
    order = within(4.0, lambda: find_order(n, prerequisites))
    assert order == list(range(n))
