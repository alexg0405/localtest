from solution import search


def test_examples():
    assert search([15, 18, 2, 5, 9], 5) == 3
    assert search([15, 18, 2, 5, 9], 4) == -1
