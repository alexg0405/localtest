from __future__ import annotations

from typing import Dict


def length_of_longest_substring(s: str) -> int:
    """Sliding window with the last index of each character: O(n) time, O(min(n, alphabet)) space."""
    last: Dict[str, int] = {}
    start = best = 0
    for i, char in enumerate(s):
        if char in last and last[char] >= start:
            start = last[char] + 1
        last[char] = i
        best = max(best, i - start + 1)
    return best
