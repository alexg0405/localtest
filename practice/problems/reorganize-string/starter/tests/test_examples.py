from collections import Counter

from solution import reorganize_string


def valid(s, answer):
    return Counter(answer) == Counter(s) and all(a != b for a, b in zip(answer, answer[1:]))


def test_examples():
    assert valid("aabc", reorganize_string("aabc"))
    assert reorganize_string("aaab") == ""
