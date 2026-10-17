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

from solution import subarray_sum


def brute(nums, k):
    return sum(1 for i in range(len(nums)) for j in range(i, len(nums)) if sum(nums[i:j + 1]) == k)


def test_examples():
    assert subarray_sum([2, -1, 1, 2], 2) == 4
    assert subarray_sum([1, 2, 3], 7) == 0


def test_zeros_count_every_subarray():
    assert subarray_sum([0, 0, 0], 0) == 6


def test_negative_numbers_rule_out_sliding_window():
    assert subarray_sum([3, -3, 3, -3], 0) == 4


def test_single_element():
    assert subarray_sum([5], 5) == 1 and subarray_sum([5], 4) == 0


def test_matches_brute_force_on_random_inputs():
    rng = random.Random(12)
    for _ in range(200):
        nums = [rng.randint(-4, 4) for _ in range(rng.randint(1, 12))]
        k = rng.randint(-5, 5)
        assert subarray_sum(nums, k) == brute(nums, k)


def test_long_input_is_fast():
    rng = random.Random(13)
    nums = [rng.randint(-10, 10) for _ in range(40_000)]
    assert within(2.0, lambda: subarray_sum(nums, 7)) > 0
