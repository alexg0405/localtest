from pricing.price_alerts import days_until_cheaper


def test_example_from_the_problem():
    assert days_until_cheaper([7, 9, 8, 6, 8, 5]) == [3, 1, 1, 2, 1, 0]
