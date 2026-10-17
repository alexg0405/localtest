from solution import num_islands


def test_example():
    grid = [["1", "1", "0", "0"], ["0", "1", "0", "1"], ["1", "0", "0", "1"]]
    assert num_islands(grid) == 3
