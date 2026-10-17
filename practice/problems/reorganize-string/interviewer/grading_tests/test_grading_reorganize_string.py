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
from collections import Counter

from solution import reorganize_string


def valid(s, answer):
    return Counter(answer) == Counter(s) and all(a != b for a, b in zip(answer, answer[1:]))


def test_examples():
    assert valid("aabc", reorganize_string("aabc"))
    assert reorganize_string("aaab") == ""


def test_single_and_empty():
    assert reorganize_string("z") == "z"
    assert reorganize_string("") == ""


def test_exactly_half_plus_one_is_possible():
    assert valid("aaabb", reorganize_string("aaabb"))
    assert valid("abababa", reorganize_string("aaaabbb"))


def test_impossible_cases():
    assert reorganize_string("aa") == ""
    assert reorganize_string("aaaabc") == ""


def test_many_distinct_letters():
    s = "aabbccddeeffgghh"
    assert valid(s, reorganize_string(s))


def test_long_input_is_fast():
    rng = random.Random(8)
    s = "".join(rng.choice("abcdefghij") for _ in range(200_000))
    answer = within(3.0, lambda: reorganize_string(s))
    assert valid(s, answer)
