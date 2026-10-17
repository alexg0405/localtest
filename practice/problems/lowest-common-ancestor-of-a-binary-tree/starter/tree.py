from __future__ import annotations

from collections import deque
from typing import List, Optional


class TreeNode:
    def __init__(self, val: int, left: "Optional[TreeNode]" = None, right: "Optional[TreeNode]" = None) -> None:
        self.val = val
        self.left = left
        self.right = right

    def __repr__(self) -> str:
        return f"TreeNode({self.val})"


def build_tree(values: List[Optional[int]]) -> Optional[TreeNode]:
    """Builds a tree from a level-order list, with None for missing children."""
    if not values or values[0] is None:
        return None
    root = TreeNode(values[0])
    queue, index = deque([root]), 1
    while queue and index < len(values):
        node = queue.popleft()
        for side in ("left", "right"):
            if index < len(values) and values[index] is not None:
                child = TreeNode(values[index])
                setattr(node, side, child)
                queue.append(child)
            index += 1
    return root


def find(root: Optional[TreeNode], value: int) -> Optional[TreeNode]:
    """Returns the node with this value, or None."""
    stack = [root]
    while stack:
        node = stack.pop()
        if node is None:
            continue
        if node.val == value:
            return node
        stack.extend((node.left, node.right))
    return None
