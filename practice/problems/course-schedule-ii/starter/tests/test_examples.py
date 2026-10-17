from solution import find_order


def test_examples():
    assert find_order(3, [[1, 0], [2, 1]]) == [0, 1, 2]
    assert find_order(2, [[0, 1], [1, 0]]) == []
