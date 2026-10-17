from __future__ import annotations

from collections import Counter


def reorganize_string(s: str) -> str:
    """Place the letters, most common first, into even indices and then odd ones. O(n) time, O(alphabet) space."""
    counts = Counter(s)
    if counts and max(counts.values()) > (len(s) + 1) // 2:
        return ""
    result = [""] * len(s)
    index = 0
    for char, count in counts.most_common():
        for _ in range(count):
            result[index] = char
            index += 2
            if index >= len(s):
                index = 1
    return "".join(result)
