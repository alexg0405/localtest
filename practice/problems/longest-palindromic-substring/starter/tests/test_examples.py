from solution import longest_palindrome


def test_examples():
    assert longest_palindrome("racecars") == "racecar"
    assert longest_palindrome("xabbay") == "abba"
    assert len(longest_palindrome("abcd")) == 1
