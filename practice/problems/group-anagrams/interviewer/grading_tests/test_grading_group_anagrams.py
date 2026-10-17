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
import string

from solution import group_anagrams


def normalize(groups):
    return sorted(sorted(group) for group in groups)


def test_example():
    result = group_anagrams(["stop", "pots", "cat", "tops", "act", "dog"])
    assert normalize(result) == normalize([["stop", "pots", "tops"], ["cat", "act"], ["dog"]])


def test_empty_strings_group_together():
    assert normalize(group_anagrams(["", "", "a"])) == [["", ""], ["a"]]


def test_duplicate_words_stay_in_one_group():
    assert normalize(group_anagrams(["ab", "ba", "ab"])) == [["ab", "ab", "ba"]]


def test_same_letters_different_counts_are_not_anagrams():
    assert normalize(group_anagrams(["aab", "abb"])) == [["aab"], ["abb"]]


def test_empty_list():
    assert group_anagrams([]) == []


def test_many_words_are_fast():
    rng = random.Random(1)
    words = ["".join(rng.choice(string.ascii_lowercase[:6]) for _ in range(8)) for _ in range(100_000)]
    groups = within(3.0, lambda: group_anagrams(words))
    assert sum(len(group) for group in groups) == len(words)
    assert all(len({"".join(sorted(w)) for w in group}) == 1 for group in groups)
