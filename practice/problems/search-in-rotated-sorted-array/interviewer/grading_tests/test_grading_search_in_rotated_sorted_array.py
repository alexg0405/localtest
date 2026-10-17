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

from solution import search


def test_examples():
    assert search([15, 18, 2, 5, 9], 5) == 3
    assert search([15, 18, 2, 5, 9], 4) == -1


def test_not_rotated():
    assert search([1, 3, 5, 7], 7) == 3


def test_target_at_the_rotation_point():
    assert search([6, 7, 1, 2, 3], 1) == 2
    assert search([6, 7, 1, 2, 3], 7) == 1


def test_one_and_two_elements():
    assert search([4], 4) == 0 and search([4], 5) == -1
    assert search([3, 1], 1) == 1 and search([3, 1], 3) == 0


def test_every_rotation_and_target():
    base = list(range(0, 40, 2))
    for shift in range(len(base)):
        nums = base[shift:] + base[:shift]
        for target in range(-1, 41):
            expected = nums.index(target) if target in nums else -1
            assert search(nums, target) == expected, (nums, target)


def test_many_searches_on_a_large_list_are_fast():
    n = 1_000_000
    nums = list(range(n // 3, n)) + list(range(n // 3))
    rng = random.Random(4)
    targets = [rng.randrange(n) for _ in range(5000)]

    def run():
        return all(nums[search(nums, t)] == t for t in targets)
    assert within(2.0, run)
