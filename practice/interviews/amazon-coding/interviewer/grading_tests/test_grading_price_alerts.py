"""Grading tests for the Amazon coding round. Kept out of the candidate workspace."""
import random
import threading

import pytest

from pricing import price_alerts
from pricing.price_alerts import days_until_cheaper


def within(seconds, function):
    """Runs function in a thread and fails if it takes longer than seconds (so a quadratic solution can't hang grading)."""
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


def slow_but_sure(prices):
    waits = []
    for day, price in enumerate(prices):
        later = next((other for other in range(day + 1, len(prices)) if prices[other] < price), None)
        waits.append(0 if later is None else later - day)
    return waits


def watch():
    if not hasattr(price_alerts, "PriceWatch"):
        pytest.fail("PriceWatch isn't written (the follow-up)")
    return price_alerts.PriceWatch()


def test_example():
    assert days_until_cheaper([7, 9, 8, 6, 8, 5]) == [3, 1, 1, 2, 1, 0]


def test_empty_history():
    assert days_until_cheaper([]) == []


def test_a_single_day_never_gets_cheaper():
    assert days_until_cheaper([42]) == [0]


def test_the_same_price_is_not_cheaper():
    assert days_until_cheaper([5, 5, 5]) == [0, 0, 0]
    assert days_until_cheaper([5, 5, 4]) == [2, 1, 0]


def test_rising_prices_never_get_cheaper():
    assert days_until_cheaper([1, 2, 3, 4]) == [0, 0, 0, 0]


def test_falling_prices_wait_one_day():
    assert days_until_cheaper([9, 7, 4, 1]) == [1, 1, 1, 0]


def test_a_dip_resolves_several_days_at_once():
    assert days_until_cheaper([3, 6, 8, 9, 2]) == [4, 3, 2, 1, 0]


def test_matches_a_slow_check_on_random_histories():
    rng = random.Random(2027)
    for _ in range(300):
        prices = [rng.randint(1, rng.choice([2, 5, 50])) for _ in range(rng.randint(0, 30))]
        assert days_until_cheaper(list(prices)) == slow_but_sure(prices), prices


def test_the_price_history_is_not_changed():
    prices = [7, 9, 8, 6, 8, 5]
    days_until_cheaper(prices)
    assert prices == [7, 9, 8, 6, 8, 5]


def test_a_long_rising_history_is_fast():
    rising = list(range(1, 100_001))
    assert within(3, lambda: days_until_cheaper(rising)) == [0] * 100_000


def test_a_long_mixed_history_is_fast():
    rng = random.Random(5)
    prices = [rng.randint(1, 1_000_000_000) for _ in range(100_000)] + list(range(1, 100_001))
    answer = within(3, lambda: days_until_cheaper(prices))
    assert len(answer) == 200_000 and answer[-1] == 0 and all(wait >= 0 for wait in answer)


def test_change_example():
    w = watch()
    assert [[tuple(pair) for pair in w.add(price)] for price in [7, 9, 8, 6, 8, 5]] == [[], [], [(1, 1)], [(0, 3), (2, 1)], [], [(3, 2), (4, 1)]]


def test_change_returns_the_oldest_day_first():
    w = watch()
    for price in [3, 6, 8, 9]:
        assert w.add(price) == []
    assert [tuple(pair) for pair in w.add(2)] == [(0, 4), (1, 3), (2, 2), (3, 1)]


def test_change_the_same_price_does_not_resolve_a_day():
    w = watch()
    assert w.add(5) == [] and w.add(5) == []
    assert [tuple(pair) for pair in w.add(4)] == [(0, 2), (1, 1)]


def test_change_matches_days_until_cheaper_on_random_feeds():
    rng = random.Random(11)
    for _ in range(200):
        prices = [rng.randint(1, rng.choice([3, 20])) for _ in range(rng.randint(0, 25))]
        w = watch()
        waits = [0] * len(prices)
        for price in prices:
            for day, wait in w.add(price):
                waits[day] = wait
        assert waits == slow_but_sure(prices), prices


def test_change_each_watch_keeps_its_own_days():
    first, second = watch(), watch()
    first.add(9)
    assert second.add(1) == [] and [tuple(pair) for pair in first.add(1)] == [(0, 1)]


def test_change_many_adds_are_fast():
    def feed():
        w = watch()
        quiet = all(not w.add(price) for price in range(1, 100_001))
        return quiet, [tuple(pair) for pair in w.add(0)]
    quiet, last = within(3, feed)
    assert quiet and last == [(day, 100_000 - day) for day in range(100_000)]
