from solution import merge


def test_examples():
    assert merge([[6, 8], [1, 3], [2, 4], [9, 10]]) == [[1, 4], [6, 8], [9, 10]]
    assert merge([[1, 5], [5, 7]]) == [[1, 7]]
