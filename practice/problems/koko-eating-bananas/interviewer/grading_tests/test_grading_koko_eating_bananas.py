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

from solution import min_eating_speed


def hours(piles, k):
    return sum((p + k - 1) // k for p in piles)


def test_examples():
    assert min_eating_speed([3, 8, 5], 6) == 3
    assert min_eating_speed([10, 4], 2) == 10


def test_one_hour_per_pile_means_the_biggest_pile():
    assert min_eating_speed([7, 1, 9, 2], 4) == 9


def test_plenty_of_time_means_speed_one():
    assert min_eating_speed([2, 3], 100) == 1


def test_single_pile():
    assert min_eating_speed([30], 7) == 5


def test_answer_is_the_minimum_on_random_inputs():
    rng = random.Random(2)
    for _ in range(200):
        piles = [rng.randint(1, 60) for _ in range(rng.randint(1, 8))]
        h = rng.randint(len(piles), 80)
        k = min_eating_speed(piles, h)
        assert hours(piles, k) <= h and (k == 1 or hours(piles, k - 1) > h)


def test_huge_piles_are_fast():
    rng = random.Random(3)
    piles = [rng.randint(1, 10 ** 9) for _ in range(10_000)]
    k = within(3.0, lambda: min_eating_speed(piles, 10 ** 9))
    assert hours(piles, k) <= 10 ** 9 and hours(piles, k - 1) > 10 ** 9
