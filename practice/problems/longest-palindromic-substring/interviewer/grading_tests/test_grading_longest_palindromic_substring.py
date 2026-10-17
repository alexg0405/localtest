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

from solution import longest_palindrome


def check(s, length):
    answer = longest_palindrome(s)
    assert answer == answer[::-1], f"{answer!r} is not a palindrome"
    assert answer in s, f"{answer!r} is not a substring"
    assert len(answer) == length


def test_examples():
    check("racecars", 7)
    check("xabbay", 4)


def test_single_characters():
    check("abcd", 1)
    check("z", 1)


def test_even_length_palindromes():
    check("cbbd", 2)
    check("abccbx", 4)


def test_whole_string_and_repeats():
    check("aaaa", 4)
    check("abacaba", 7)


def test_palindrome_at_the_end():
    check("abcdedc", 5)


def test_long_input_is_fast():
    rng = random.Random(5)
    s = "".join(rng.choice("ab") for _ in range(2000))
    answer = within(4.0, lambda: longest_palindrome(s))
    assert answer == answer[::-1] and answer in s
    best = max(len(s[i:j]) for i in range(0, 2000, 400) for j in range(i + 1, min(2000, i + 40)) if s[i:j] == s[i:j][::-1])
    assert len(answer) >= best
