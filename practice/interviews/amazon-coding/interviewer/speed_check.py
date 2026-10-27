"""For the interviewer only: is the candidate's solution correct, and is it fast enough to call optimal?

Run from the candidate's workspace as `python speed_check.py main DAYS` (days_until_cheaper) or `python speed_check.py
followup DAYS` (PriceWatch). It checks the answers on short random price histories first, then times DAYS days of
rising prices, where no day ever gets cheaper: a nested loop scans to the end from every day there, so it's quadratic.
Each check prints one JSON line as soon as it's done, so a run stopped partway still says what it found.
"""
import json
import os
import random
import sys
import time

sys.path[0] = os.getcwd()   # the candidate's workspace, not this folder
DAYS = int(sys.argv[2]) if len(sys.argv) > 2 else 12_000


def reference(prices):
    waits, waiting = [0] * len(prices), []
    for day, price in enumerate(prices):
        while waiting and prices[waiting[-1]] > price:
            earlier = waiting.pop()
            waits[earlier] = day - earlier
        waiting.append(day)
    return waits


def resolved_by_day(prices):
    """What PriceWatch.add should return for each price, from the reference answer."""
    waits = reference(prices)
    out = [[] for _ in prices]
    for day, wait in enumerate(waits):
        if wait:
            out[day + wait].append((day, wait))
    return out


def say(**fields):
    print(json.dumps(fields), flush=True)


def histories():
    rng = random.Random(20261027)
    yield []
    yield [5]
    yield [4, 4, 4]
    for _ in range(40):
        yield [rng.randint(1, rng.choice([3, 10, 1000])) for _ in range(rng.randint(1, 40))]


def check_main():
    try:
        from pricing.price_alerts import days_until_cheaper
    except Exception as error:  # noqa: BLE001 - anything the candidate's module does on import
        return say(check="correct", ok=False, missing=True, detail=f"{type(error).__name__}: {error}")
    for prices in histories():
        try:
            got = days_until_cheaper(list(prices))
        except NotImplementedError:
            return say(check="correct", ok=False, missing=True, detail="not written yet")
        except Exception as error:  # noqa: BLE001
            return say(check="correct", ok=False, detail=f"{type(error).__name__} on {prices}")
        if list(got) != reference(prices):
            return say(check="correct", ok=False, detail=f"wrong answer on {prices}")
    say(check="correct", ok=True)
    rising = list(range(1, DAYS + 1))
    start = time.perf_counter()
    got = days_until_cheaper(rising)
    say(check="speed", seconds=round(time.perf_counter() - start, 4), ok=list(got) == [0] * DAYS)


def check_followup():
    try:
        from pricing.price_alerts import PriceWatch
    except Exception as error:  # noqa: BLE001
        return say(check="correct", ok=False, missing=True, detail=f"{type(error).__name__}: {error}")
    for prices in histories():
        try:
            watch = PriceWatch()
            got = [[tuple(pair) for pair in watch.add(price)] for price in prices]
        except NotImplementedError:
            return say(check="correct", ok=False, missing=True, detail="not written yet")
        except Exception as error:  # noqa: BLE001
            return say(check="correct", ok=False, detail=f"{type(error).__name__} on {prices}")
        if got != resolved_by_day(prices):
            return say(check="correct", ok=False, detail=f"wrong answer on {prices}")
    say(check="correct", ok=True)
    watch = PriceWatch()
    start = time.perf_counter()
    quiet = all(not watch.add(price) for price in range(1, DAYS + 1))
    last = [tuple(pair) for pair in watch.add(0)]
    say(check="speed", seconds=round(time.perf_counter() - start, 4), ok=quiet and last == [(day, DAYS - day) for day in range(DAYS)])


if __name__ == "__main__":
    check_followup() if sys.argv[1:2] == ["followup"] else check_main()
