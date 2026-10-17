from __future__ import annotations

from collections import OrderedDict
from typing import Hashable


class LRUCache:
    """A hash map plus recency order. OrderedDict keeps keys in a doubly linked list, so moves and evictions are O(1)."""

    def __init__(self, capacity: int) -> None:
        self.capacity = capacity
        self.items: "OrderedDict[Hashable, int]" = OrderedDict()

    def get(self, key: Hashable) -> int:
        if key not in self.items:
            return -1
        self.items.move_to_end(key)
        return self.items[key]

    def put(self, key: Hashable, value: int) -> None:
        if key in self.items:
            self.items.move_to_end(key)
        self.items[key] = value
        if len(self.items) > self.capacity:
            self.items.popitem(last=False)
