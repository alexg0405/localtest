from pricing.price_alerts import PriceWatch


def test_example_from_the_follow_up():
    watch = PriceWatch()
    assert [[tuple(pair) for pair in watch.add(price)] for price in [7, 9, 8, 6, 8, 5]] == [[], [], [(1, 1)], [(0, 3), (2, 1)], [], [(3, 2), (4, 1)]]
