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

from solution import length_of_longest_substring


def test_examples():
    assert length_of_longest_substring("abcbdea") == 5
    assert length_of_longest_substring("zzzz") == 1


def test_empty_and_single():
    assert length_of_longest_substring("") == 0
    assert length_of_longest_substring("q") == 1


def test_window_start_never_moves_backwards():
    assert length_of_longest_substring("abba") == 2
    assert length_of_longest_substring("tmmzuxt") == 5


def test_restart_in_the_middle():
    assert length_of_longest_substring("dvdf") == 3


def test_spaces_and_symbols_count_as_characters():
    assert length_of_longest_substring("a b!a") == 4


def test_all_distinct():
    assert length_of_longest_substring("abcdefghij") == 10


def test_long_input_is_fast():
    s = "".join(chr(0x4E00 + (i % 2000)) for i in range(200_000))
    assert within(3.0, lambda: length_of_longest_substring(s)) == 2000
