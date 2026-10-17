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

import random

from solution import LRUCache


def test_example():
    cache = LRUCache(2)
    cache.put("a", 1)
    cache.put("b", 2)
    assert cache.get("a") == 1
    cache.put("c", 3)
    assert cache.get("b") == -1 and cache.get("a") == 1 and cache.get("c") == 3


def test_updating_a_key_refreshes_it_and_does_not_evict():
    cache = LRUCache(2)
    cache.put(1, 1)
    cache.put(2, 2)
    cache.put(1, 10)
    cache.put(3, 3)
    assert cache.get(1) == 10 and cache.get(2) == -1 and cache.get(3) == 3


def test_get_counts_as_a_use():
    cache = LRUCache(2)
    cache.put(1, 1)
    cache.put(2, 2)
    cache.get(1)
    cache.put(3, 3)
    assert cache.get(2) == -1 and cache.get(1) == 1


def test_missing_key_returns_minus_one():
    assert LRUCache(3).get("nope") == -1


def test_capacity_one():
    cache = LRUCache(1)
    cache.put(1, 1)
    cache.put(2, 2)
    assert cache.get(1) == -1 and cache.get(2) == 2


def test_matches_a_reference_on_random_operations():
    rng = random.Random(9)
    cache, reference, capacity = LRUCache(5), [], 5
    for _ in range(3000):
        key = rng.randrange(12)
        if rng.random() < 0.5:
            value = rng.randrange(100)
            cache.put(key, value)
            reference = [pair for pair in reference if pair[0] != key] + [(key, value)]
            reference = reference[-capacity:]
        else:
            found = next((v for k, v in reference if k == key), -1)
            if found != -1:
                reference = [pair for pair in reference if pair[0] != key] + [(key, found)]
            assert cache.get(key) == found


def test_many_operations_are_fast():
    def run():
        cache = LRUCache(5000)
        for i in range(300_000):
            cache.put(i % 9000, i)
            cache.get((i * 7) % 9000)
        return cache.get(299_999 % 9000)
    assert within(4.0, run) == 299_999
