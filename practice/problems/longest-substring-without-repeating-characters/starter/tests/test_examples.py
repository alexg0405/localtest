from solution import length_of_longest_substring


def test_examples():
    assert length_of_longest_substring("abcbdea") == 5
    assert length_of_longest_substring("zzzz") == 1
    assert length_of_longest_substring("") == 0
