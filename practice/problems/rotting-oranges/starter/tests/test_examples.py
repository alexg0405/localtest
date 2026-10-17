from solution import oranges_rotting


def test_examples():
    assert oranges_rotting([[2, 1, 0], [1, 1, 0], [0, 1, 1]]) == 4
    assert oranges_rotting([[2, 0, 1]]) == -1
