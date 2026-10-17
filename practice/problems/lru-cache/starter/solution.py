from __future__ import annotations

from typing import Hashable


class LRUCache:
    def __init__(self, capacity: int) -> None:
        raise NotImplementedError

    def get(self, key: Hashable) -> int:
        """Returns the value for key, or -1 if it isn't in the cache."""
        raise NotImplementedError

    def put(self, key: Hashable, value: int) -> None:
        """Inserts or updates key, evicting the least recently used key when over capacity."""
        raise NotImplementedError
