from __future__ import annotations

from typing import List


def longest_streak(days: List[int]) -> int:
    """The length of the creator's longest streak: the most consecutive days with at least one note on each.

    O(n): a streak can only start on a day with no note the day before, so each day is walked over once.
    """
    posted = set(days)   # several notes on one day count once
    best = 0
    for day in posted:
        if day - 1 not in posted:
            length = 1
            while day + length in posted:
                length += 1
            best = max(best, length)
    return best


def longest_streak_with_freezes(days: List[int], freezes: int) -> int:
    """The longest streak when up to `freezes` days without a note can be covered. A streak starts and ends on a day
    with a note.

    O(n log n): sort the distinct days once, then slide a window over them, shrinking it while the days it's missing
    are more than the freezes.
    """
    posted = sorted(set(days))
    best = left = 0
    for right, day in enumerate(posted):
        while (day - posted[left] + 1) - (right - left + 1) > freezes:
            left += 1
        best = max(best, day - posted[left] + 1)
    return best
