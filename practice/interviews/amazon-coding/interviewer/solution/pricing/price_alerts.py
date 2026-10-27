from __future__ import annotations

from typing import List, Tuple


def days_until_cheaper(prices: List[int]) -> List[int]:
    """For each day, how many days until the item's price is lower than that day's, or 0 if it never is.

    One pass with a stack of the days still waiting for a lower price. Their prices never decrease from the bottom of
    the stack to the top, so a new price resolves a run of days at the top. Every day is pushed once and popped at
    most once: O(n) time, O(n) space.
    """
    waits = [0] * len(prices)
    waiting: List[int] = []
    for day, price in enumerate(prices):
        while waiting and prices[waiting[-1]] > price:
            earlier = waiting.pop()
            waits[earlier] = day - earlier
        waiting.append(day)
    return waits


class PriceWatch:
    """The follow-up: prices arrive one day at a time, and each day's wait is reported as soon as it's known."""

    def __init__(self) -> None:
        self._waiting: List[Tuple[int, int]] = []  # (day, price), prices never decreasing toward the top
        self._today = 0

    def add(self, price: int) -> List[Tuple[int, int]]:
        """Records the next day's price and returns the (day, wait) pairs it resolves, oldest day first.
        O(1) amortized: each day is pushed once and popped at most once."""
        resolved = []
        while self._waiting and self._waiting[-1][1] > price:
            day, _ = self._waiting.pop()
            resolved.append((day, self._today - day))
        self._waiting.append((self._today, price))
        self._today += 1
        resolved.reverse()  # popped newest first
        return resolved
