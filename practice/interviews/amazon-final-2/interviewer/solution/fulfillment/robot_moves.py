from __future__ import annotations

from collections import deque
from typing import List, Set, Tuple


def min_moves(grid: List[str], clears: int = 0) -> int:
    """Fewest moves from the dock (D) to the nearest pick station (P), passing through at most `clears` shelves.

    Breadth-first search over (row, col, clears_left): every move costs 1, so the first time BFS reaches a station
    is the shortest path. O(R * C * (clears + 1)) time and space.
    """
    starts = [(r, c) for r, row in enumerate(grid) for c, cell in enumerate(row) if cell == "D"]
    if not starts:
        raise ValueError("the grid has no dock (D)")
    rows, cols = len(grid), len(grid[0])
    start = (starts[0][0], starts[0][1], clears)
    seen: Set[Tuple[int, int, int]] = {start}
    queue = deque([(start, 0)])
    while queue:
        (r, c, left), moves = queue.popleft()
        if grid[r][c] == "P":
            return moves
        for nr, nc in ((r + 1, c), (r - 1, c), (r, c + 1), (r, c - 1)):
            if not (0 <= nr < rows and 0 <= nc < cols):
                continue
            remaining = left - 1 if grid[nr][nc] == "#" else left
            state = (nr, nc, remaining)
            if remaining >= 0 and state not in seen:
                seen.add(state)
                queue.append((state, moves + 1))
    return -1
