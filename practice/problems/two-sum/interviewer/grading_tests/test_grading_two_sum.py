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

from solution import two_sum


def test_examples():
    assert two_sum([4, 9, 1, 7], 8) == [2, 3]


def test_duplicate_values():
    assert two_sum([5, 5, 2], 10) == [0, 1]
    assert two_sum([1, 3, 3], 6) == [1, 2]


def test_negative_numbers_and_zero():
    assert two_sum([-3, 4, 3, 90], 0) == [0, 2]
    assert two_sum([0, 8, 0], 0) == [0, 2]


def test_pair_at_the_ends():
    assert two_sum([2, 11, 15, 30, 7], 9) == [0, 4]


def test_large_input_is_fast():
    nums = list(range(1, 200_001))
    target = nums[-1] + nums[-2]
    assert within(2.0, lambda: two_sum(nums, target)) == [199_998, 199_999]
