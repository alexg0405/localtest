from __future__ import annotations

from collections import defaultdict
from typing import DefaultDict, List, Tuple


def group_anagrams(words: List[str]) -> List[List[str]]:
    """Key each word by its sorted letters: O(n · k log k) time for n words of length k, O(n · k) space."""
    groups: DefaultDict[Tuple[str, ...], List[str]] = defaultdict(list)
    for word in words:
        groups[tuple(sorted(word))].append(word)
    return list(groups.values())
