from __future__ import annotations

from typing import List


def min_eating_speed(piles: List[int], h: int) -> int:
    """Binary search the speed between 1 and max(piles): O(n log max(piles)) time, O(1) space."""
    low, high = 1, max(piles)
    while low < high:
        speed = (low + high) // 2
        if sum((pile + speed - 1) // speed for pile in piles) <= h:
            high = speed
        else:
            low = speed + 1
    return low
